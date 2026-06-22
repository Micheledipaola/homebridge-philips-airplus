"""Button entities for Philips Air+ integration."""
from __future__ import annotations

import logging

from homeassistant.components.button import ButtonEntity, ButtonEntityDescription
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import PhilipsAirplusDataCoordinator

_LOGGER = logging.getLogger(__name__)

# All button descriptions, keyed by the button key used in models.yaml.
# models.yaml is the single source of truth for which buttons a model exposes.
ALL_BUTTON_DESCRIPTIONS: dict[str, ButtonEntityDescription] = {
    "reset_filter_clean": ButtonEntityDescription(
        key="reset_filter_clean",
        translation_key="reset_filter_clean",
        entity_category=EntityCategory.CONFIG,
        icon="mdi:air-filter",
    ),
    "reset_filter_replace": ButtonEntityDescription(
        key="reset_filter_replace",
        translation_key="reset_filter_replace",
        entity_category=EntityCategory.CONFIG,
        icon="mdi:air-filter",
    ),
}



async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Philips Air+ buttons.

    Entities are registered lazily: we wait until the coordinator has identified
    the device model (via MQTT Config port or restored from cache).  Once the
    model is known the listener removes itself — it will never fire again.
    """
    coordinator: PhilipsAirplusDataCoordinator = hass.data[DOMAIN][entry.entry_id]

    _added_for: str | None = None
    unsub_ref: list = [None]

    def _try_add() -> None:
        nonlocal _added_for
        model_name = coordinator._model_config.get("name")
        if not model_name or _added_for == model_name:
            return

        button_keys: list[str] = coordinator._model_config.get("buttons", [])
        entities = [
            PhilipsAirplusButton(coordinator, entry, ALL_BUTTON_DESCRIPTIONS[key])
            for key in button_keys
            if key in ALL_BUTTON_DESCRIPTIONS
        ]
        for key in button_keys:
            if key not in ALL_BUTTON_DESCRIPTIONS:
                _LOGGER.warning("Button key '%s' in models.yaml has no description, skipping", key)

        _added_for = model_name
        if entities:
            _LOGGER.debug("Adding %d button(s) for model %s", len(entities), model_name)
            async_add_entities(entities)

        # Unsubscribe — model is identified, listener is no longer needed
        if unsub_ref[0]:
            unsub_ref[0]()
            unsub_ref[0] = None

    unsub_ref[0] = coordinator.async_add_listener(_try_add)
    entry.async_on_unload(lambda: unsub_ref[0]() if unsub_ref[0] else None)
    _try_add()  # Immediate attempt in case model is already known from cache


class PhilipsAirplusButton(CoordinatorEntity, ButtonEntity):
    """Representation of a Philips Air+ button."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: PhilipsAirplusDataCoordinator,
        entry: ConfigEntry,
        description: ButtonEntityDescription,
    ) -> None:
        """Initialize the button."""
        super().__init__(coordinator)
        self.entry = entry
        self.entity_description = description

        self._attr_unique_id = f"{entry.data['device_uuid']}_{description.key}"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.data["device_uuid"])},
            "name": entry.data["device_name"],
            "manufacturer": "Philips",
            "model": coordinator._model_config.get("name"),
        }

    @property
    def available(self) -> bool:
        """Return True if entity is available."""
        return self.coordinator.is_connected

    async def async_press(self) -> None:
        """Handle button press."""
        key = self.entity_description.key
        if key == "reset_filter_clean":
            ok = await self.coordinator.reset_filter_clean()
        elif key == "reset_filter_replace":
            ok = await self.coordinator.reset_filter_replace()
        else:
            _LOGGER.error("No action defined for button key '%s'", key)
            return
        if not ok:
            _LOGGER.warning(
                "Button '%s' failed for %s",
                key,
                self.entry.data.get("device_name"),
            )
