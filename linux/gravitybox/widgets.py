from __future__ import annotations

from pathlib import Path
from typing import Any

from PyQt5.QtCore import QRectF, Qt
from PyQt5.QtGui import QColor, QFont, QLinearGradient, QPainter, QPainterPath, QPen, QPixmap
from PyQt5.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QSizePolicy,
    QToolTip,
    QVBoxLayout,
    QWidget,
)

from .paths import resolve_model_icons_dir
from .theme import ThemeColors


def format_tokens(count: int | float | None) -> str:
    n = int(count or 0)
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.2f}B"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def format_usd(amount: float | int | None) -> str:
    val = float(amount or 0.0)
    if val <= 0:
        return "$0.00"
    if val < 0.01:
        return f"${val:.4f}"
    return f"${val:.2f}"


def format_bytes(num_bytes: int | float | None) -> str:
    size = float(num_bytes or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024.0
    return "0 B"


class Card(QFrame):
    def __init__(self, object_name: str = "Card", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName(object_name)
        self.setFrameShape(QFrame.NoFrame)


class PillBadge(QLabel):
    def __init__(self, text: str = "", tone: str = "neutral", theme: ThemeColors | None = None, parent: QWidget | None = None) -> None:
        super().__init__(text, parent)
        self._tone = tone
        self._theme = theme
        self.setAlignment(Qt.AlignCenter)
        self.setSizePolicy(QSizePolicy.Maximum, QSizePolicy.Fixed)
        self.apply_tone(tone, theme)

    def apply_tone(self, tone: str, theme: ThemeColors | None = None) -> None:
        self._tone = tone
        if theme is not None:
            self._theme = theme
        t = self._theme
        if t is None:
            return
        palette = {
            "blue": (t.blue_soft, t.blue),
            "green": (t.green_soft, t.green),
            "amber": (t.amber_soft, t.amber),
            "red": (t.red_soft, t.red),
            "purple": (t.purple_soft, t.purple),
            "neutral": (t.subcard, t.secondary),
        }
        bg, fg = palette.get(tone, palette["neutral"])
        self.setStyleSheet(
            f"background-color: {bg}; color: {fg}; border-radius: 10px; "
            "padding: 2px 9px; font-size: 11px; font-weight: 600;"
        )


class ProgressBarWidget(QWidget):
    """Smooth pill-shaped quota/share bar matching GravityBox Design.swift."""

    def __init__(self, fraction: float | None = 0.0, theme: ThemeColors | None = None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._fraction = fraction
        self._theme = theme
        self.setFixedHeight(7)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

    def set_value(self, fraction: float | None, theme: ThemeColors | None = None) -> None:
        self._fraction = fraction
        if theme is not None:
            self._theme = theme
        self.update()

    def paintEvent(self, _event: Any) -> None:
        if self.width() <= 2 or self.height() <= 1:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        t = self._theme
        track_color = QColor(t.track if t else "#E2E4EC")
        radius = self.height() / 2.0
        track_rect = QRectF(0, 0, self.width(), self.height())
        path = QPainterPath()
        path.addRoundedRect(track_rect, radius, radius)
        p.fillPath(path, track_color)

        if self._fraction is None:
            return
        frac = max(0.0, min(1.0, float(self._fraction)))
        if frac <= 0.001:
            return
        if frac <= 0.15:
            color = QColor(t.red if t else "#C62828")
        elif frac <= 0.35:
            color = QColor(t.amber if t else "#B45309")
        else:
            color = QColor(t.blue if t else "#007AFF")

        fill_w = max(float(self.height()), self.width() * frac)
        p.setClipPath(path)
        grad = QLinearGradient(0, 0, fill_w, 0)
        start = QColor(color)
        start.setAlphaF(0.78)
        grad.setColorAt(0.0, start)
        grad.setColorAt(1.0, color)
        fill_path = QPainterPath()
        fill_path.addRoundedRect(QRectF(0, 0, fill_w, self.height()), radius, radius)
        p.fillPath(fill_path, grad)


class QuotaBarRow(QWidget):
    def __init__(
        self,
        title: str,
        percent: float | None,
        reset_text: str,
        theme: ThemeColors,
        subtitle: str = "",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 2, 0, 2)
        lay.setSpacing(4)

        top = QHBoxLayout()
        top.setContentsMargins(0, 0, 0, 0)
        lbl_title = QLabel(title)
        lbl_title.setStyleSheet("font-size: 12.5px; font-weight: 600;")
        top.addWidget(lbl_title)
        if subtitle:
            lbl_sub = QLabel(subtitle)
            lbl_sub.setObjectName("Secondary")
            top.addWidget(lbl_sub)
        top.addStretch(1)
        if reset_text:
            lbl_reset = QLabel(reset_text)
            lbl_reset.setObjectName("Secondary")
            top.addWidget(lbl_reset)
        pct_str = f"{int(round(percent))}%" if percent is not None else "--"
        lbl_pct = QLabel(pct_str)
        lbl_pct.setStyleSheet("font-size: 12.5px; font-weight: 700; min-width: 38px;")
        lbl_pct.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        top.addWidget(lbl_pct)
        lay.addLayout(top)

        bar = ProgressBarWidget((percent / 100.0) if percent is not None else None, theme)
        lay.addWidget(bar)


class MetricTile(Card):
    def __init__(self, title: str, value: str = "--", detail: str = "", parent: QWidget | None = None) -> None:
        super().__init__("Card", parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 12, 14, 12)
        lay.setSpacing(4)
        self.title_label = QLabel(title)
        self.title_label.setObjectName("Secondary")
        self.value_label = QLabel(value)
        self.value_label.setObjectName("MetricValue")
        self.detail_label = QLabel(detail)
        self.detail_label.setObjectName("Secondary")
        self.detail_label.setWordWrap(True)
        lay.addWidget(self.title_label)
        lay.addWidget(self.value_label)
        lay.addWidget(self.detail_label)

    def set_data(self, title: str, value: str, detail: str) -> None:
        self.title_label.setText(title)
        self.value_label.setText(value)
        self.detail_label.setText(detail)


class BarTrendChart(QWidget):
    """Lightweight interactive bar chart for 24h hourly or multi-day usage trends."""

    def __init__(self, theme: ThemeColors, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._theme = theme
        self._points: list[tuple[str, float, str]] = []
        self._hover_idx: int = -1
        self.setMinimumHeight(140)
        self.setMouseTracking(True)

    def set_points(self, points: list[tuple[str, float, str]], theme: ThemeColors | None = None) -> None:
        self._points = points
        if theme is not None:
            self._theme = theme
        self._hover_idx = -1
        self.update()

    def mouseMoveEvent(self, event: Any) -> None:
        if not self._points:
            return
        w = max(1, self.width() - 24)
        n = len(self._points)
        idx = int((event.x() - 12) / (w / n))
        if 0 <= idx < n:
            if idx != self._hover_idx:
                self._hover_idx = idx
                self.update()
            label, _val, tip = self._points[idx]
            QToolTip.showText(event.globalPos(), f"{label}\n{tip}", self)
        else:
            self._hover_idx = -1
            self.update()

    def leaveEvent(self, _event: Any) -> None:
        self._hover_idx = -1
        self.update()

    def paintEvent(self, _event: Any) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        t = self._theme
        rect = self.rect()
        left, right, top, bottom = 12, 12, 12, 24
        chart_w = max(10, rect.width() - left - right)
        chart_h = max(10, rect.height() - top - bottom)

        # Baseline
        p.setPen(QPen(QColor(t.border), 1))
        p.drawLine(left, top + chart_h, left + chart_w, top + chart_h)

        if not self._points:
            p.setPen(QColor(t.secondary))
            p.drawText(rect, Qt.AlignCenter, "--")
            return

        max_val = max((pt[1] for pt in self._points), default=0.0)
        n = len(self._points)
        slot_w = chart_w / max(1, n)
        bar_w = max(3.0, min(22.0, slot_w * 0.62))

        font = QFont()
        font.setPointSize(8)
        p.setFont(font)

        step_label = max(1, n // 6)
        for i, (label, val, _tip) in enumerate(self._points):
            cx = left + (i + 0.5) * slot_w
            bx = cx - bar_w / 2.0
            ratio = (val / max_val) if max_val > 0 else 0.0
            bh = max(2.0 if val > 0 else 0.0, chart_h * ratio)
            by = top + chart_h - bh

            if bh > 0:
                color = QColor(t.blue)
                if i == self._hover_idx:
                    color = color.lighter(115)
                else:
                    color.setAlphaF(0.84)
                bar_path = QPainterPath()
                bar_path.addRoundedRect(QRectF(bx, by, bar_w, bh), 3.0, 3.0)
                p.fillPath(bar_path, color)

            if i % step_label == 0 or i == n - 1:
                p.setPen(QColor(t.secondary))
                p.drawText(QRectF(cx - 24, top + chart_h + 4, 48, 16), Qt.AlignCenter, label[-5:])


class ModelIconProvider:
    def __init__(self, resource_root: Path) -> None:
        self._dir = resolve_model_icons_dir(resource_root)
        self._cache: dict[str, QPixmap] = {}

    def pixmap_for(self, model_name: str, size: int = 18) -> QPixmap | None:
        lower = (model_name or "").lower()
        key = None
        if "claude" in lower or "anthropic" in lower:
            key = "claude.png"
        elif "gemini" in lower or "argon" in lower or "carbon" in lower or "google" in lower:
            key = "gemini.png"
        elif "gpt" in lower or "openai" in lower or "o1" in lower or "o3" in lower:
            key = "openai.png"
        if not key:
            return None
        cache_key = f"{key}:{size}"
        if cache_key in self._cache:
            return self._cache[cache_key]
        path = self._dir / key
        if not path.is_file():
            return None
        pm = QPixmap(str(path))
        if pm.isNull():
            return None
        scaled = pm.scaled(size, size, Qt.KeepAspectRatio, Qt.SmoothTransformation)
        self._cache[cache_key] = scaled
        return scaled
