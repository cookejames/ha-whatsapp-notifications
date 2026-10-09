"""Options flow (recipients). Stub: owned by ticket T09."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlowResult, OptionsFlow
import voluptuous as vol


class WhatsAppOptionsFlow(OptionsFlow):
    """Placeholder options flow; T09 replaces this with the recipients menu."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Show an empty form."""
        if user_input is not None:
            return self.async_create_entry(data=dict(self.config_entry.options))
        return self.async_show_form(step_id="init", data_schema=vol.Schema({}))
