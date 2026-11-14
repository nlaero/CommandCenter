import assert from "node:assert/strict";
import { PUBLIC_CAMERAS } from "./publicCameraData.ts";
import { parseCaltrans, parseMaryland, parseNyc, feedsFor } from "./publicCameraFeeds.ts";
import {
  applyPublicCamera,
  bandFor,
  mergeCameras,
  milesBetween,
  recommendCameras,
  searchCameras,
  sealPublicCamera,
} from "./publicCameras.ts";
import { playbackHasAudio } from "./streamMedia.ts";

const oakland = PUBLIC_CAMERAS.find((camera) => camera.id === "ct-d4-1");
const park = PUBLIC_CAMERAS.find((camera) => camera.name.includes("Central Park"));
assert.ok(oakland);
assert.ok(park);
assert.equal(park.media, "image");
assert.equal(playbackHasAudio(park.media === "image" ? "image" : "hls"), false);

const featured = recommendCameras(PUBLIC_CAMERAS, null);
assert.ok(featured.length >= 4);
assert.ok(featured.some((hit) => hit.camera.media === "image"));
assert.ok(featured.some((hit) => hit.camera.media === "hls"));
assert.ok(featured.every((hit) => hit.camera.featured && hit.miles == null));

const atCamera = recommendCameras(PUBLIC_CAMERAS, { lat: oakland.lat, lon: oakland.lon });
assert.equal(atCamera[0]?.camera.id, oakland.id);
assert.equal(atCamera[0]?.band, "near");
assert.ok((atCamera[0]?.miles ?? 99) < 1);

const pittsburgh = { lat: 40.4748, lon: -79.7881 };
const fromHome = recommendCameras(PUBLIC_CAMERAS, pittsburgh);
assert.equal(fromHome[0]?.camera.region, "Maryland");
assert.equal(fromHome[0]?.band, "farther");
assert.ok((fromHome[0]?.miles ?? 0) > 80);
const nycMiles = milesBetween(pittsburgh, park);
assert.ok(nycMiles > (fromHome[0]?.miles ?? 0));

const found = searchCameras(PUBLIC_CAMERAS, "central park", null);
assert.equal(found.length, 1);
assert.equal(found[0]?.camera.id, park.id);
assert.equal(searchCameras(PUBLIC_CAMERAS, "zzzz-no-camera", null).length, 0);

const applied = applyPublicCamera(
  { nearLat: 40.4, nearLon: -79.8, location: { confirmed: true, lat: 40.4, lon: -79.8 } },
  park,
);
assert.equal(applied.nearLat, 40.4);
assert.equal(applied.url, park.url);
assert.equal(applied.label, park.name);
assert.equal(applied.cameraId, park.id);

const sealed = sealPublicCamera({ ...applied, url: "https://evil.example/swap.jpg", label: "Park cam" });
assert.equal(sealed.ok, true);
if (sealed.ok) {
  assert.equal(sealed.params.url, park.url);
  assert.equal(sealed.params.label, "Park cam");
  assert.equal(sealed.refresh, park.refresh);
}
assert.equal(sealPublicCamera({}).ok, false);
assert.equal(bandFor(10), "near");
assert.equal(bandFor(40), "metro");
assert.equal(bandFor(200), "farther");

const merged = mergeCameras(PUBLIC_CAMERAS, [
  { ...park, id: "extra-1", url: "https://example.test/other.jpg" },
  { ...oakland, url: "https://example.test/same-id.jpg" },
]);
assert.equal(merged.length, PUBLIC_CAMERAS.length + 1);

const caltrans = parseCaltrans(4, {
  data: [
    {
      cctv: {
        index: "9",
        inService: "true",
        location: {
          locationName: "Bay Bridge",
          nearbyPlace: "Oakland",
          latitude: "37.8",
          longitude: "-122.3",
        },
        imageData: {
          static: { currentImageURL: "https://cwwp2.dot.ca.gov/data/d4/cctv/image/bay.jpg", currentImageUpdateFrequency: "5" },
          streamingVideoURL: "Not Reported",
        },
      },
    },
    {
      cctv: {
        index: "10",
        inService: "false",
        location: { locationName: "Down", nearbyPlace: "Oakland", latitude: "37", longitude: "-122" },
        imageData: { static: { currentImageURL: "https://cwwp2.dot.ca.gov/down.jpg" } },
      },
    },
  ],
});
assert.equal(caltrans.length, 1);
assert.equal(caltrans[0]?.id, "ct-d4-9");
assert.equal(caltrans[0]?.media, "image");
assert.equal(caltrans[0]?.refresh, "5s");

const nyc = parseNyc([
  {
    id: "abc",
    name: "Broadway",
    latitude: 40.7,
    longitude: -74,
    area: "Manhattan",
    isOnline: "true",
    imageUrl: "https://webcams.nyctmc.org/api/cameras/abc/image",
  },
]);
assert.equal(nyc[0]?.place, "Manhattan, New York");
assert.equal(nyc[0]?.media, "image");

const maryland = parseMaryland({
  data: [
    {
      id: "abcdef0123456789",
      name: "100",
      description: "I-95 at Baltimore",
      opStatus: "OK",
      cctvIp: "strmr5.sha.maryland.gov",
      lat: 39.2,
      lon: -76.6,
    },
    {
      id: "abcdef0123456789",
      name: "Bad host",
      opStatus: "OK",
      cctvIp: "https://evil.example",
      lat: 39,
      lon: -76,
    },
  ],
});
assert.equal(maryland.length, 1);
assert.equal(maryland[0]?.media, "hls");
assert.equal(maryland[0]?.name, "I-95 at Baltimore");
assert.match(maryland[0]?.url ?? "", /^https:\/\/strmr5\.sha\.maryland\.gov\/rtplive\/abcdef0123456789\/playlist\.m3u8$/);

assert.deepEqual(
  feedsFor("oakland", null).map((feed) => feed.id),
  ["caltrans-d4"],
);
assert.deepEqual(
  feedsFor("", pittsburgh).map((feed) => feed.id),
  ["maryland"],
);
const bay = feedsFor("", { lat: 37.8, lon: -122.27 }).map((feed) => feed.id);
assert.equal(bay[0], "caltrans-d4");
assert.ok(bay.length <= 2);
assert.ok(feedsFor("new york", pittsburgh).some((feed) => feed.id === "nyc"));

console.log("publicCameras.test.ts ok");
