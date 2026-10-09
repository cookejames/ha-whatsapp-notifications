"""Config flow for the WhatsApp (Gateway) integration."""

from __future__ import annotations

from collections.abc import Mapping
import logging
from typing import Any

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
import voluptuous as vol

from .api import GatewayApiError, GatewayAuthError, WhatsAppGatewayClient
from .const import CONF_API_KEY, CONF_URL, DEFAULT_TITLE, DEFAULT_URL, DOMAIN
from .options_flow import WhatsAppOptionsFlow

_LOGGER = logging.getLogger(__name__)

PASSWORD_SELECTOR = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))


def normalize_url(url: str) -> str:
    """Normalise a gateway URL for use as a unique id."""
    return url.strip().rstrip("/").lower()


class WhatsAppConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for WhatsApp (Gateway)."""

    VERSION = 1

    async def _validate(self, url: str, api_key: str) -> str | None:
        """Return an error key if the gateway cannot be used, else None."""
        client = WhatsAppGatewayClient(async_get_clientsession(self.hass), url, api_key)
        try:
            await client.status()
        except GatewayAuthError:
            return "invalid_auth"
        except GatewayApiError:
            return "cannot_connect"
        except Exception:
            _LOGGER.exception("Unexpected error validating gateway")
            return "unknown"
        return None

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            await self.async_set_unique_id(normalize_url(url))
            self._abort_if_unique_id_configured()
            if error := await self._validate(url, user_input[CONF_API_KEY]):
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title=DEFAULT_TITLE,
                    data={CONF_URL: url, CONF_API_KEY: user_input[CONF_API_KEY]},
                )

        defaults = user_input or {}
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_URL, default=defaults.get(CONF_URL, DEFAULT_URL)
                    ): str,
                    vol.Required(CONF_API_KEY): PASSWORD_SELECTOR,
                }
            ),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Start reauthentication."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for a new API key."""
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()
        if user_input is not None:
            if error := await self._validate(
                entry.data[CONF_URL], user_input[CONF_API_KEY]
            ):
                errors["base"] = error
            else:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_API_KEY: user_input[CONF_API_KEY]}
                )
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_API_KEY): PASSWORD_SELECTOR}),
            description_placeholders={CONF_URL: entry.data[CONF_URL]},
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        """Return the options flow."""
        return WhatsAppOptionsFlow()
