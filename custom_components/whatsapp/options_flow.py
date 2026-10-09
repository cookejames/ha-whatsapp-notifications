"""Options flow: manage person and group recipients."""

from __future__ import annotations

import re
from typing import Any
import uuid

from homeassistant.config_entries import ConfigFlowResult, OptionsFlow
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)
import voluptuous as vol

from .api import GatewayApiError, GatewayAuthError, GatewayConnectionError
from .const import CONF_RECIPIENTS

_PHONE_STRIP = re.compile(r"[\s\-.()]")
_PHONE_RE = re.compile(r"\d{7,15}")


def normalize_phone(phone: str) -> str | None:
    """Return the digits of a valid phone number (spec 3.7 step 4), else None."""
    cleaned = _PHONE_STRIP.sub("", phone.strip())
    cleaned = cleaned.removeprefix("+")
    return cleaned if _PHONE_RE.fullmatch(cleaned) else None


class WhatsAppOptionsFlow(OptionsFlow):
    """Add and remove recipients."""

    def __init__(self) -> None:
        """Initialise the flow."""
        self._recipients: list[dict[str, str]] = []

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Show the menu."""
        self._recipients = list(self.config_entry.options.get(CONF_RECIPIENTS, []))
        menu = ["add_person", "add_group"]
        if self._recipients:
            menu.append("remove")
        return self.async_show_menu(step_id="init", menu_options=menu)

    def _save(self) -> ConfigFlowResult:
        return self.async_create_entry(data={CONF_RECIPIENTS: self._recipients})

    async def async_step_add_person(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Add a person by phone number."""
        errors: dict[str, str] = {}
        if user_input is not None:
            digits = normalize_phone(user_input["phone"])
            if digits is None:
                errors["phone"] = "invalid_phone"
            else:
                self._recipients.append(
                    {
                        "id": uuid.uuid4().hex,
                        "name": user_input["name"].strip(),
                        "target": f"{digits}@s.whatsapp.net",
                        "kind": "user",
                    }
                )
                return self._save()
        return self.async_show_form(
            step_id="add_person",
            data_schema=self.add_suggested_values_to_schema(
                vol.Schema({vol.Required("name"): str, vol.Required("phone"): str}),
                user_input,
            ),
            errors=errors,
        )

    async def async_step_add_group(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Add a group picked from the live group list."""
        try:
            groups = await self.config_entry.runtime_data.client.groups()
        except GatewayAuthError:
            return self._group_error("invalid_auth")
        except GatewayConnectionError:
            return self._group_error("cannot_connect")
        except GatewayApiError:
            return self._group_error("unknown")
        if not groups:
            return self.async_abort(reason="no_groups")

        names = {g["jid"]: g["name"] for g in groups}
        if user_input is not None and user_input["group"] in names:
            jid = user_input["group"]
            name = (user_input.get("name") or "").strip() or names[jid]
            self._recipients.append(
                {
                    "id": uuid.uuid4().hex,
                    "name": name,
                    "target": jid,
                    "kind": "group",
                }
            )
            return self._save()

        options = [
            SelectOptionDict(value=jid, label=name) for jid, name in names.items()
        ]
        schema = vol.Schema(
            {
                vol.Required("group"): SelectSelector(
                    SelectSelectorConfig(
                        options=options, mode=SelectSelectorMode.DROPDOWN
                    )
                ),
                vol.Optional("name"): str,
            }
        )
        return self.async_show_form(step_id="add_group", data_schema=schema)

    def _group_error(self, error: str) -> ConfigFlowResult:
        """Show the group step with an error (no group list available)."""
        return self.async_show_form(
            step_id="add_group",
            data_schema=vol.Schema({}),
            errors={"base": error},
        )

    async def async_step_remove(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Remove recipients."""
        if user_input is not None:
            gone = set(user_input["recipients"])
            self._recipients = [r for r in self._recipients if r["id"] not in gone]
            return self._save()
        options = [
            SelectOptionDict(value=r["id"], label=r["name"]) for r in self._recipients
        ]
        schema = vol.Schema(
            {
                vol.Required("recipients"): SelectSelector(
                    SelectSelectorConfig(options=options, multiple=True)
                )
            }
        )
        return self.async_show_form(step_id="remove", data_schema=schema)
