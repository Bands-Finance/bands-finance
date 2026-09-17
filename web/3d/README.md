# The desk (3D)

The engraved desk behind the top of the dashboard is one Blender scene, built from code.

- `build_desk.py` builds the whole scene, exports `../public/3d/desk.glb` for the site and saves `desk.blend` to open by hand.
- The site (`../src/stage/`) loads the `.glb`, redraws it as an engraving and lays out the live parts: one tray per open band,
  one strapped bundle per bin that still holds SOL, a dark slab per bin the price has crossed, the brass cursor where the
  price is, one coin in the dish per tenth of a SOL of fees.

Rebuild after a change:

```
blender -b -P web/3d/build_desk.py -- web/public/3d/desk.glb web/3d/desk.blend
```

What the site relies on (keep these when editing in Blender):

- Material NAMES pick the engraving treatment: Paper, Bill, Page, Ivory, Tape, Felt, Brass, Wood, Ink, Strap, Ember, Glass.
- `Proto.*` objects (Tray, Cursor, Stack, Strap, Chip, Coin) are prototypes the site instances from live data.
- `Cam.N` / `Look.N` empties are the camera stations of the scroll journey, N being the beat. Move them to reframe a beat.
  A `follow = "cursor"` property makes a station slide along the tray to wherever the price is.
- A custom property `outline = 0` on an object skips its ink contour.

To look at a station without the page: `npm run dev`, then `/stage-dev.html?p=2` (or `?cam=x,y,z&look=x,y,z&fov=30` in
Blender coordinates to try a camera before writing it into the script).
