# The desk (3D)

The engraved desk behind the top of the dashboard is one Blender scene, built from code.

- `build_desk.py` builds the whole scene, exports `desk.glb` beside it (the site imports it as a hashed asset, so browsers cache it
  for good and still see every new export) and saves `desk.blend` to open by hand.
- The site (`../src/stage/`) loads the `.glb`, redraws it as an engraving and lays out the live parts: one tray per open band,
  one strapped bundle per bin that still holds SOL, a dark slab per bin the price has crossed, the brass cursor where the
  price is, one coin in the dish per tenth of a SOL of fees.

Rebuild after a change:

```
blender -b -P web/3d/build_desk.py -- web/3d/desk.glb web/3d/desk.blend
```

What the site relies on (keep these when editing in Blender):

- The model sheet is `ref/mr-bands-sheet.png`, with a written reading in `ref/SHEET.md`; it wins over the older single
  drawing `ref/mr-bands-full.png`. The hat's orange is a VERTICAL STRIPE over the crown (`hat_stripe()` lays it; both the
  figure's hat and the desk's hat prop use it), never a band.
- The trousers' pinstripes are drawn by the shader from a cylindrical UV laid round each leg's own axis (`stripe_uvs()`,
  run after the families are meshed, on every mesh whose material is Stripe), so they hang straight however a leg tilts.
- Material NAMES pick the engraving treatment: Paper, Bill, Page, Ivory, Tape, Felt, Brass, Wood, Ink, Cloth, Stripe (pinstripes), Shoe (polished leather), Strap, Ember, Glass.
- `Proto.*` objects (Tray, Cursor, Stack, Strap, Chip, Coin) are prototypes the site instances from live data.
- `Cam.<name>` / `Look.<name>` empties are the camera stations of the scroll journey (hero, rows, cursor, row0, row1, vault, dish,
  chart, plan, ledger, tape, hat, him). A chapter on the page names the station it stands at. Move them to reframe a chapter.
  `follow = "cursor"` slides a station along the tray to the price; `follow = "row0"` keeps it on that tray and its cursor;
  `drift_x/y/z` lets the camera wander while a long block (the ledger) scrolls past.
- `Chart.Seats` is where the site stands the coin columns of the fee abacus (`count`, `pitch`).
- A custom property `outline = 0` on an object skips its ink contour.
- The site cuts `Fig.*` (anything under `Figure`) finer than the rest of the plate: a thinner contour and lines at 0.85 of the
  desk's pitch, on top of the per-material `pitch` factor in `SPECS` (`src/stage/engrave.ts`). A soft shadowless fill from the
  front keeps his face readable under the brim. Keep new figure parts under `Figure` so they get the same treatment.
  The export joins him into the `Desk.<Material>` meshes with the rest of the static desk, so the site cuts him back out at load by
  WHERE he stands (`splitFigure` in `DeskStage.ts`): the box of the materials only he wears (Shoe, Stripe, Cloth), widened 1.5 units
  for the cane and the cigar hand. Keep those three materials his alone, and keep desk props out of that box.

- `Figure` is Mr Bands himself (`Fig.*`), standing on the blotter behind the rows at `FIG_AT`, turned `FIG_YAW` degrees toward
  the hero camera. The reference is `ref/mr-bands-full.png`. His soft forms are metaball families, one per material (`Family` in
  the script: head, hands, coat, waistcoat, trousers, moustache), each turned into one smooth mesh at export; the crisp things
  (hat, shades, bow tie, cigar, cane, buttons) are primitives. At stiffness 4 the visible surface is 0.684 of an element's radius,
  and the helpers take real dimensions.
- A station may TURN while its chapter scrolls: `TURNS` gives it `orbit_deg` (a walk round the look point), `zoom_to` (the
  distance it closes to, as a factor) and `rise` (how far the look point lifts). The `him` station makes one full turn and
  closes on his face. The page side: a beat with `travel` (window heights) pins its words while a block that tall scrolls.

To look at a station without the page: `npm run dev`, then `/stage-dev.html?s=chart` (or `?cam=x,y,z&look=x,y,z&fov=30` in
Blender coordinates to try a camera before writing it into the script). `&fade=0` skips the boot fade, for a screenshot;
`&hold=0..1` stands a turning station part way through its chapter.
A third argument to the build renders a workbench preview PNG; `PREVIEW_STATION=him` picks the station it is taken from.
