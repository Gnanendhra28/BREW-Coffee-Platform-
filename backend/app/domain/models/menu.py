"""BREW Coffee Platform — Menu Domain Models & Static Catalog."""

import json
from pathlib import Path
from typing import List, Optional, Literal, Dict
from pydantic import BaseModel, Field

CategoryType = Literal["all", "coffee", "tea", "shakes", "desserts"]


class MenuItem(BaseModel):
    id: str
    name: str
    category: Literal["coffee", "tea", "shakes", "desserts"]
    categoryLabel: str
    price: float
    rating: float
    reviewsCount: int
    description: str
    notes: Optional[List[str]] = None
    volumeOrCalories: Optional[str] = None
    badge: Optional[Literal["Popular", "Signature", "Artisanal", "Organic", "Chef's Pick"]] = None
    image: str


class CategoryItem(BaseModel):
    id: CategoryType
    label: str
    iconName: str


_CATALOG_PATH = Path(__file__).parent / "menu_catalog.json"
_raw_data = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))

MENU_ITEMS: List[MenuItem] = [MenuItem(**item) for item in _raw_data.get("items", [])]
CATEGORIES: List[CategoryItem] = [CategoryItem(**cat) for cat in _raw_data.get("categories", [])]
MENU_MAP: Dict[str, MenuItem] = {item.id: item for item in MENU_ITEMS}
