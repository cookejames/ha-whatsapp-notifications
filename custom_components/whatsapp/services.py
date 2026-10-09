"""Services for the WhatsApp (Gateway) integration (spec 4.6)."""

from __future__ import annotations

import base64
import mimetypes
import os
from typing import TYPE_CHECKING, Any

from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
    callback,
)
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
import voluptuous as vol

from .api import (
    GatewayApiError,
    GatewayAuthError,
    GatewayConnectionError,
    GatewayError,
)
from .const import CONF_RECIPIENTS, DOMAIN, MAX_MEDIA_BYTES

if TYPE_CHECKING:
    from . import WhatsAppConfigEntry

SERVICE_SEND_MESSAGE = "send_message"
SERVICE_LIST_GROUPS = "list_groups"

ATTR_CONFIG_ENTRY_ID = "config_entry_id"
ATTR_TARGET = "target"
ATTR_MESSAGE = "message"
ATTR_TITLE = "title"
ATTR_IMAGE_URL = "image_url"
ATTR_IMAGE_PATH = "image_path"
ATTR_DOCUMENT_PATH = "document_path"
ATTR_CAPTION = "caption"

SEND_MESSAGE_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string,
        vol.Required(ATTR_TARGET): vol.All(cv.ensure_list, [cv.string], vol.Length(1)),
        vol.Optional(ATTR_MESSAGE): cv.string,
        vol.Optional(ATTR_TITLE): cv.string,
        vol.Optional(ATTR_IMAGE_URL): cv.string,
        vol.Optional(ATTR_IMAGE_PATH): cv.string,
        vol.Optional(ATTR_DOCUMENT_PATH): cv.string,
        vol.Optional(ATTR_CAPTION): cv.string,
    }
)

LIST_GROUPS_SCHEMA = vol.Schema({vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string})


class _FileTooLargeError(Exception):
    """The file is larger than the media limit."""


@callback
def async_setup_services(hass: HomeAssistant) -> None:
    """Register the integration services."""
    hass.services.async_register(
        DOMAIN,
        SERVICE_SEND_MESSAGE,
        _async_send_message,
        schema=SEND_MESSAGE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_LIST_GROUPS,
        _async_list_groups,
        schema=LIST_GROUPS_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )


def _get_entry(hass: HomeAssistant, entry_id: str | None) -> WhatsAppConfigEntry:
    """Return the config entry to use for a service call."""
    if entry_id is not None:
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN:
            raise ServiceValidationError(
                translation_domain=DOMAIN, translation_key="config_entry_not_found"
            )
        return entry
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="config_entry_not_found"
        )
    if len(entries) > 1:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="multiple_config_entries"
        )
    return entries[0]


def _gateway_exception(err: GatewayApiError) -> HomeAssistantError:
    """Map a client error to a translated Home Assistant error."""
    placeholders = None
    if isinstance(err, GatewayAuthError):
        key = "invalid_auth"
    elif isinstance(err, GatewayConnectionError):
        key = "cannot_connect"
    elif isinstance(err, GatewayError) and err.code == "not_connected":
        key = "not_connected"
    else:
        key = "gateway_error"
        placeholders = {
            "error": err.message if isinstance(err, GatewayError) else str(err)
        }
    return HomeAssistantError(
        translation_domain=DOMAIN,
        translation_key=key,
        translation_placeholders=placeholders,
    )


def _resolve_targets(
    hass: HomeAssistant, entry: WhatsAppConfigEntry, targets: list[str]
) -> list[str]:
    """Map notify entity ids to recipient targets; pass other items through."""
    registry = er.async_get(hass)
    prefix = f"{entry.entry_id}_"
    recipients = {
        str(rec["id"]): rec["target"]
        for rec in entry.options.get(CONF_RECIPIENTS, [])
        if "id" in rec and "target" in rec
    }
    resolved: list[str] = []
    for item in targets:
        if not item.startswith("notify."):
            resolved.append(item)
            continue
        reg_entry = registry.async_get(item)
        unique_id = reg_entry.unique_id if reg_entry else ""
        recipient_id = unique_id[len(prefix) :]
        if (
            reg_entry is None
            or reg_entry.platform != DOMAIN
            or reg_entry.config_entry_id != entry.entry_id
            or not unique_id.startswith(prefix)
            or recipient_id not in recipients
        ):
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="target_error",
                translation_placeholders={
                    "target": item,
                    "error": "not a WhatsApp recipient entity",
                },
            )
        resolved.append(recipients[recipient_id])
    return resolved


def _read_file(path: str) -> bytes:
    """Read a file, refusing anything over the media limit."""
    with open(path, "rb") as file:
        data = file.read(MAX_MEDIA_BYTES + 1)
    if len(data) > MAX_MEDIA_BYTES:
        raise _FileTooLargeError
    return data


async def _async_load_file(hass: HomeAssistant, path: str) -> str:
    """Check a local path is allowed, read it in an executor, return base64."""
    if not hass.config.is_allowed_path(path):
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="path_not_allowed",
            translation_placeholders={"path": path},
        )
    try:
        raw = await hass.async_add_executor_job(_read_file, path)
    except _FileTooLargeError as err:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="file_too_large",
            translation_placeholders={"path": path},
        ) from err
    except OSError as err:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="file_read_error",
            translation_placeholders={"path": path, "error": str(err)},
        ) from err
    return base64.b64encode(raw).decode("ascii")


async def _async_send_message(call: ServiceCall) -> ServiceResponse:
    """Handle whatsapp.send_message."""
    hass = call.hass
    data = call.data
    image_url = data.get(ATTR_IMAGE_URL)
    image_path = data.get(ATTR_IMAGE_PATH)
    document_path = data.get(ATTR_DOCUMENT_PATH)
    message = data.get(ATTR_MESSAGE)
    title = data.get(ATTR_TITLE)
    caption = data.get(ATTR_CAPTION)

    media_sources = [x for x in (image_url, image_path, document_path) if x]
    if len(media_sources) > 1:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="multiple_media"
        )
    if not message and not media_sources:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="message_required"
        )

    entry = _get_entry(hass, data.get(ATTR_CONFIG_ENTRY_ID))
    targets = _resolve_targets(hass, entry, data[ATTR_TARGET])

    text = message or None
    if title and text:
        text = f"*{title}*\n{text}"

    image: dict[str, Any] | None = None
    document: dict[str, Any] | None = None
    if image_url:
        image = {"url": image_url}
    elif image_path:
        image = {"base64": await _async_load_file(hass, image_path)}
    elif document_path:
        document = {
            "base64": await _async_load_file(hass, document_path),
            "filename": os.path.basename(document_path),
            "mimetype": mimetypes.guess_type(document_path)[0]
            or "application/octet-stream",
        }
    media = image or document
    if media is not None and caption:
        media["caption"] = caption

    try:
        results = await entry.runtime_data.client.send(
            targets, message=text, image=image, document=document
        )
    except GatewayApiError as err:
        raise _gateway_exception(err) from err

    if results and all("error" in result for result in results):
        errors = "; ".join(
            f"{result.get('to')}: {result['error'].get('message', 'unknown error')}"
            for result in results
        )
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="all_targets_failed",
            translation_placeholders={"errors": errors},
        )
    return {"results": results}


async def _async_list_groups(call: ServiceCall) -> ServiceResponse:
    """Handle whatsapp.list_groups."""
    entry = _get_entry(call.hass, call.data.get(ATTR_CONFIG_ENTRY_ID))
    try:
        groups = await entry.runtime_data.client.groups()
    except GatewayApiError as err:
        raise _gateway_exception(err) from err
    return {
        "groups": [
            {
                "name": group["name"],
                "jid": group["jid"],
                "participants": group["participants"],
            }
            for group in groups
        ]
    }
