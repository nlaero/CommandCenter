import assert from "node:assert/strict";
import { cameraCount, cameraGridColumns, cameraRotateSec, visibleCameras } from "./penndotCameras.ts";
import { parsePenndotCameras, trafficRadius } from "./traffic.ts";
import type { TrafficCamera } from "../types.ts";

assert.equal(trafficRadius(undefined), 80);
assert.equal(trafficRadius("12.4"), 12);
assert.equal(trafficRadius(1), 5);
assert.equal(trafficRadius(900), 200);
assert.equal(cameraCount(0), 1);
assert.equal(cameraCount(3.2), 3);
assert.equal(cameraCount(40), 8);
assert.equal(cameraRotateSec(2), 5);
assert.equal(cameraRotateSec(90), 90);
assert.equal(cameraGridColumns(1), 1);
assert.equal(cameraGridColumns(4), 2);
assert.equal(cameraGridColumns(8), 4);

function cam(id: string): TrafficCamera {
  return {
    id,
    name: id,
    lat: 0,
    lon: 0,
    miles: 0,
    views: [{ id, label: id, imageUrl: "https://www.511pa.com/map/Cctv/1" }],
  };
}

const four = [cam("a"), cam("b"), cam("c"), cam("d")];
assert.deepEqual(visibleCameras(four, 2, 0, false).map((item) => item.id), ["a", "b"]);
assert.deepEqual(visibleCameras(four, 2, 1, true).map((item) => item.id), ["b", "c"]);
assert.deepEqual(visibleCameras(four, 2, 3, true).map((item) => item.id), ["d", "a"]);
assert.deepEqual(visibleCameras(four, 8, 1, true).map((item) => item.id), ["a", "b", "c", "d"]);

const parsed = parsePenndotCameras(
  {
    data: [
      {
        id: 100,
        visible: true,
        roadway: "I-376",
        county: "Allegheny",
        location: "I-376 @ Penn Hills",
        cameraName: "CAM1",
        latLng: { geography: { wellKnownText: "POINT (-79.835 40.475)" } },
        images: [
          { id: 55, imageUrl: "/map/Cctv/55", description: "Eastbound", blocked: false, disabled: false },
          { id: 56, imageUrl: "https://evil.example/shot.jpg", blocked: false },
        ],
      },
      {
        id: 101,
        visible: true,
        location: "Far camera",
        latLng: { geography: { wellKnownText: "POINT (-77.0 41.9)" } },
        images: [{ id: 57, imageUrl: "/map/Cctv/57", blocked: false, disabled: false }],
      },
      {
        id: 102,
        visible: false,
        location: "Hidden",
        latLng: { geography: { wellKnownText: "POINT (-79.84 40.48)" } },
        images: [{ id: 58, imageUrl: "/map/Cctv/58", blocked: true, disabled: false }],
      },
    ],
  },
  40.475,
  -79.835,
  80,
);
assert.equal(parsed.unreadable, false);
assert.equal(parsed.cameras.length, 1);
assert.equal(parsed.cameras[0]?.id, "penndot-cam:100");
assert.equal(parsed.cameras[0]?.name, "I-376 @ Penn Hills");
assert.equal(parsed.cameras[0]?.road, "I-376");
assert.equal(parsed.cameras[0]?.county, "Allegheny");
assert.equal(parsed.cameras[0]?.views.length, 1);
assert.equal(parsed.cameras[0]?.views[0]?.imageUrl, "https://www.511pa.com/map/Cctv/55");
assert.equal(parsePenndotCameras({ data: [] }, 40.475, -79.835, 5).cameras.length, 0);
assert.equal(parsePenndotCameras({ nope: true }, 0, 0, 80).unreadable, true);
