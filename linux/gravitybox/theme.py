from __future__ import annotations

import subprocess
from dataclasses import dataclass

from PyQt5.QtGui import QColor, QPalette
from PyQt5.QtWidgets import QApplication


@dataclass(frozen=True)
class ThemeColors:
    dark: bool
    bg: str
    sidebar: str
    card: str
    subcard: str
    track: str
    border: str
    text: str
    secondary: str
    blue: str
    blue_soft: str
    green: str
    green_soft: str
    amber: str
    amber_soft: str
    red: str
    red_soft: str
    purple: str
    purple_soft: str


LIGHT = ThemeColors(
    dark=False,
    bg="#F5F6F9",
    sidebar="#ECEEF4",
    card="#FFFFFF",
    subcard="#F2F4F8",
    track="#E2E4EC",
    border="#DCDFE8",
    text="#1D1D1F",
    secondary="#6E6E73",
    blue="#007AFF",
    blue_soft="rgba(0, 122, 255, 0.12)",
    green="#1F8A4C",
    green_soft="rgba(31, 138, 76, 0.12)",
    amber="#B45309",
    amber_soft="rgba(180, 83, 9, 0.12)",
    red="#C62828",
    red_soft="rgba(198, 40, 40, 0.12)",
    purple="#6D28D9",
    purple_soft="rgba(109, 40, 217, 0.12)",
)

DARK = ThemeColors(
    dark=True,
    bg="#1C1C1E",
    sidebar="#161618",
    card="#242428",
    subcard="#2C2C31",
    track="#38383E",
    border="#36363D",
    text="#F2F2F7",
    secondary="#98989F",
    blue="#0A84FF",
    blue_soft="rgba(10, 132, 255, 0.18)",
    green="#30D158",
    green_soft="rgba(48, 209, 88, 0.18)",
    amber="#FBBF24",
    amber_soft="rgba(251, 191, 36, 0.18)",
    red="#FB7185",
    red_soft="rgba(251, 113, 133, 0.18)",
    purple="#A78BFA",
    purple_soft="rgba(167, 139, 250, 0.18)",
)


def detect_dark_mode(app: QApplication | None = None) -> bool:
    try:
        out = subprocess.check_output(
            ["gsettings", "get", "org.gnome.desktop.interface", "color-scheme"],
            stderr=subprocess.DEVNULL,
            timeout=0.8,
        ).decode("utf-8", errors="ignore").strip().lower()
        if "prefer-dark" in out:
            return True
        if "prefer-light" in out or "default" in out:
            return False
    except Exception:
        pass
    if app is not None:
        bg: QColor = app.palette().color(QPalette.Window)
        return bg.lightness() < 128
    return False


def build_stylesheet(t: ThemeColors) -> str:
    return f"""
    QMainWindow, QDialog, QStackedWidget, QWidget#PageBody {{
        background-color: {t.bg};
        color: {t.text};
        font-family: "Ubuntu", "Noto Sans CJK SC", "PingFang SC", "Inter", sans-serif;
        font-size: 13px;
    }}
    QScrollArea, QScrollArea > QWidget, QScrollArea > QWidget > QWidget {{
        background-color: {t.bg};
        border: none;
    }}
    QWidget {{
        color: {t.text};
    }}
    QFrame#Sidebar {{
        background-color: {t.sidebar};
        border-right: 1px solid {t.border};
    }}
    QFrame#Card {{
        background-color: {t.card};
        border: 1px solid {t.border};
        border-radius: 13px;
    }}
    QFrame#SubCard {{
        background-color: {t.subcard};
        border: 1px solid {t.border};
        border-radius: 10px;
    }}
    QFrame#WarnBanner {{
        background-color: {t.amber_soft};
        border: 1px solid {t.amber};
        border-radius: 12px;
    }}
    QFrame#DangerBanner {{
        background-color: {t.red_soft};
        border: 1px solid {t.red};
        border-radius: 12px;
    }}
    QLabel#PageTitle {{
        font-size: 20px;
        font-weight: 700;
        color: {t.text};
    }}
    QLabel#SectionTitle {{
        font-size: 14px;
        font-weight: 600;
        color: {t.text};
    }}
    QLabel#MetricValue {{
        font-size: 22px;
        font-weight: 700;
        color: {t.text};
    }}
    QLabel#Secondary {{
        color: {t.secondary};
        font-size: 12px;
    }}
    QPushButton {{
        background-color: {t.subcard};
        color: {t.text};
        border: 1px solid {t.border};
        border-radius: 8px;
        padding: 6px 12px;
        font-weight: 500;
    }}
    QPushButton:hover {{
        border-color: {t.blue};
    }}
    QPushButton:disabled {{
        color: {t.secondary};
        opacity: 0.6;
    }}
    QPushButton#PrimaryBtn {{
        background-color: {t.blue};
        color: #FFFFFF;
        border: 1px solid {t.blue};
        font-weight: 600;
    }}
    QPushButton#PrimaryBtn:hover {{
        background-color: #0066D6;
    }}
    QPushButton#DangerBtn {{
        background-color: {t.red_soft};
        color: {t.red};
        border: 1px solid {t.red};
    }}
    QPushButton#NavBtn {{
        text-align: left;
        background-color: transparent;
        border: none;
        border-radius: 9px;
        padding: 9px 12px;
        font-size: 13.5px;
        font-weight: 500;
        color: {t.secondary};
    }}
    QPushButton#NavBtn:hover {{
        background-color: {t.subcard};
        color: {t.text};
    }}
    QPushButton#NavBtn[active="true"] {{
        background-color: {t.blue_soft};
        color: {t.blue};
        font-weight: 600;
    }}
    QComboBox, QLineEdit, QSpinBox, QTextEdit, QPlainTextEdit {{
        background-color: {t.subcard};
        color: {t.text};
        border: 1px solid {t.border};
        border-radius: 8px;
        padding: 5px 9px;
    }}
    QComboBox::drop-down {{
        border: none;
        width: 22px;
    }}
    QScrollArea {{
        border: none;
        background-color: {t.bg};
    }}
    QScrollBar:vertical {{
        background: transparent;
        width: 8px;
        margin: 2px;
    }}
    QScrollBar::handle:vertical {{
        background: {t.track};
        border-radius: 4px;
        min-height: 24px;
    }}
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
        height: 0px;
    }}
    QCheckBox {{
        spacing: 8px;
    }}
    QTabWidget::pane {{
        border: 1px solid {t.border};
        border-radius: 10px;
        background: {t.card};
    }}
    QTabBar::tab {{
        background: {t.subcard};
        color: {t.secondary};
        border: 1px solid {t.border};
        border-bottom: none;
        padding: 6px 14px;
        border-top-left-radius: 8px;
        border-top-right-radius: 8px;
        margin-right: 4px;
    }}
    QTabBar::tab:selected {{
        background: {t.card};
        color: {t.blue};
        font-weight: 600;
    }}
    """
