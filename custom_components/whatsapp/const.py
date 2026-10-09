"""Constants for the WhatsApp (Gateway) integration."""

from __future__ import annotations

from datetime import timedelta
from typing import Final

from homeassistant.const import Platform

DOMAIN: Final = "whatsapp"

PLATFORMS: Final = [Platform.BINARY_SENSOR, Platform.NOTIFY]

CONF_URL: Final = "url"
CONF_API_KEY: Final = "api_key"
CONF_RECIPIENTS: Final = "recipients"

DEFAULT_URL: Final = "http://local-whatsapp-gateway:8099"
DEFAULT_TITLE: Final = "WhatsApp Gateway"
DEVICE_NAME: Final = "WhatsApp"

STATUS_SCAN_INTERVAL: Final = timedelta(seconds=60)

# Request timeouts in seconds (spec 4.2).
TIMEOUT_SEND: Final = 30
TIMEOUT_DEFAULT: Final = 10

# Maximum media size accepted by the gateway (spec 3.9).
MAX_MEDIA_BYTES: Final = 16 * 1024 * 1024
