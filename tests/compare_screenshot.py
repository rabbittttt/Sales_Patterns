"""Compare region size and strongly different pixels; tolerate font antialiasing."""
import sys
from PIL import Image, ImageChops

with Image.open(sys.argv[1]) as reference, Image.open(sys.argv[2]) as actual:
    if reference.size != actual.size:
        sys.exit(f"Region size changed: {reference.size} -> {actual.size}")
    bands = ImageChops.difference(reference.convert("RGB"), actual.convert("RGB")).split()
    delta = ImageChops.lighter(ImageChops.lighter(*bands[:2]), bands[2])
    fraction = sum(delta.histogram()[48:]) / (actual.width * actual.height)
    if fraction > 0.035:
        sys.exit(f"{fraction:.1%} of region pixels changed")
