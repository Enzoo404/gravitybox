from __future__ import annotations

import json
import locale
import os
from pathlib import Path

from .paths import resolve_i18n_dir


def detect_system_locale() -> str:
    for var in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
        val = os.environ.get(var, "").strip()
        if val:
            lower = val.lower()
            if lower.startswith("zh"):
                return "zh-Hans"
            if lower.startswith("en"):
                return "en"
    try:
        loc = locale.getlocale()[0] or ""
        if loc.lower().startswith("zh"):
            return "zh-Hans"
    except Exception:
        pass
    return "en"


def normalize_locale(requested: str | None) -> str:
    req = (requested or "system").strip()
    if not req or req == "system":
        return detect_system_locale()
    if req.lower().startswith("zh"):
        return "zh-Hans"
    return "en"


class L10n:
    def __init__(self, resource_root: Path, preference: str = "system") -> None:
        self._i18n_dir = resolve_i18n_dir(resource_root)
        self._bundles: dict[str, dict[str, str]] = {}
        self.preference = preference
        self.locale = normalize_locale(preference)
        self._load_all()

    def _load_all(self) -> None:
        for code in ("en", "zh-Hans"):
            path = self._i18n_dir / f"{code}.json"
            try:
                raw = json.loads(path.read_text("utf-8"))
                app_map = raw.get("app") if isinstance(raw.get("app"), dict) else {}
                backend_map = raw.get("backend") if isinstance(raw.get("backend"), dict) else {}
                merged: dict[str, str] = {}
                for k, v in backend_map.items():
                    if isinstance(v, str):
                        merged[k] = v
                for k, v in app_map.items():
                    if isinstance(v, str):
                        merged[k] = v
                self._bundles[code] = merged
            except Exception:
                self._bundles[code] = {}

    def set_preference(self, preference: str) -> str:
        self.preference = preference or "system"
        self.locale = normalize_locale(self.preference)
        return self.locale

    @property
    def is_zh(self) -> bool:
        return self.locale.startswith("zh")

    def t(self, key: str, fallback: str | None = None, **params: object) -> str:
        text = self._bundles.get(self.locale, {}).get(key)
        if text is None:
            text = self._bundles.get("en", {}).get(key)
        if text is None:
            text = fallback if fallback is not None else key
        if params:
            for pk, pv in params.items():
                text = text.replace("{" + pk + "}", str(pv))
        return text

    def bi(self, zh: str, en: str) -> str:
        return zh if self.is_zh else en
