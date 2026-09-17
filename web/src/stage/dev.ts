// Dev only (web/stage-dev.html): the stage alone, a station picked by ?p=, fake bands by ?bands=, for looking at the engraving.
import { Vector3 } from "three";
import { DeskStage } from "./DeskStage";
import deskUrl from "../../3d/desk.glb?url";
const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const stage = new DeskStage(canvas);
const n = +(q.get("bands") ?? 2);
const bands = [
  { label: "ALLINU/SOL", lowerPrice: 0.0002068, upperPrice: 0.0002588, activePrice: +(q.get("price") ?? 0.0002384), bins: 46 },
  { label: "GP/SOL", lowerPrice: 0.0000601, upperPrice: 0.000071, activePrice: 0.0000735, bins: 23 },
].slice(0, n);
stage.setData({ bands, feesSol: +(q.get("fees") ?? 3.0), chart: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 6, 9, 5, 11, 14, 8, 6, 10, 4, 7] });
stage.setMotion(false);
// ?s=<station name> stands the camera at a named station
if (q.get("s")) stage.setRoute([q.get("s")!, "hero"]);
stage
  .load(deskUrl)
  .then(() => {
    stage.setProgress(+(q.get("p") ?? 0));
    // ?cam=x,y,z&look=x,y,z&fov=30 in BLENDER coordinates (z up), to compose a station before writing it into build_desk.py
    const v = (k: string) => q.get(k)?.split(",").map(Number);
    const cam = v("cam"), look = v("look");
    if (cam && look) stage.debugPose = { pos: new Vector3(cam[0], cam[2], -cam[1]), look: new Vector3(look[0], look[2], -look[1]), fov: +(q.get("fov") ?? 30) };
    if (q.get("fx") || q.get("fy")) stage.debugFrame = { x: +(q.get("fx") ?? 0), y: +(q.get("fy") ?? 0) };
    stage.setProgress(+(q.get("p") ?? 0));
    (window as unknown as { __stage: DeskStage }).__stage = stage;
    document.getElementById("hud")!.textContent = `p=${q.get("p") ?? 0} stations=${stage.stations}`;
    document.title = "ready";
  })
  .catch((e) => {
    document.getElementById("hud")!.textContent = String(e);
    document.title = "error";
  });
addEventListener("resize", () => stage.resize());
