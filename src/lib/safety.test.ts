import assert from "node:assert/strict";
import {
  choosePlacement,
  clampRadius,
  feedsSaveError,
  foldTransmission,
  formatMiles,
  formatRadioTranscript,
  hitId,
  insideRadius,
  labelMatchesState,
  learnPerson,
  looksLikeUnitId,
  looksLikeZipList,
  milesBetween,
  nextIncidentId,
  personFromVoice,
  personPhrase,
  placeQuery,
  previewTranscript,
  readCall,
  readPreparedCall,
  readTransmission,
  transcriptText,
  type OpenIncident,
  type TransmissionRead,
} from "./safety.ts";

const fire = readCall("Engine 12, structure fire, 100 Grant Street. Smoke showing.");
assert.equal(fire?.dispatchType, "Structure fire");
assert.equal(fire?.severity, "alert");
assert.equal(fire?.heardAddress, "100 Grant Street");

const block = readCall("Working fire, 4500 block of Frankstown Road.");
assert.equal(block?.dispatchType, "Structure fire");
assert.equal(block?.heardAddress, "4500 block of Frankstown Road");

const abbreviated = readCall("Medic 4, chest pain, 22 Penn Ave.");
assert.equal(abbreviated?.dispatchType, "Medical");
assert.equal(abbreviated?.heardAddress, "22 Penn Avenue");

const crossing = readCall("Accident at Frankstown Road and Saltsburg Road.");
assert.equal(crossing?.dispatchType, "Crash");
assert.equal(crossing?.heardAddress, "Frankstown Road and Saltsburg Road");

const loose = readCall("Crash near Frankstown and Saltsburg.");
assert.equal(loose?.heardAddress, "Frankstown and Saltsburg");

assert.equal(readCall("Dispatch, unit responding. Copy, standing by."), null);
assert.equal(readCall("Engine 12, structure fire, no street given."), null);

const fixed = readPreparedCall("Engine 12, structure fire, 100 Grant Stree.", (text) =>
  text.split("100 Grant Stree").join("100 Grant Street"),
);
assert.equal(fixed?.heardAddress, "100 Grant Street");
assert.equal(fixed?.dispatchType, "Structure fire");

assert.equal(
  placeQuery("100 Grant Street", "Allegheny", "PA"),
  "100 Grant Street, Allegheny County, Pennsylvania",
);
assert.equal(
  placeQuery("100 Grant Street", "Allegheny County", "Pennsylvania"),
  "100 Grant Street, Allegheny County, Pennsylvania",
);
assert.equal(/\b\d{5}\b/.test(placeQuery("100 Grant Street", "Allegheny", "PA")), false);

assert.equal(
  labelMatchesState("100 Grant Street, Pittsburgh, Pennsylvania, United States", "PA"),
  true,
);
assert.equal(
  labelMatchesState("100 Grant Street, Columbus, Ohio, United States", "PA"),
  false,
);
assert.equal(
  labelMatchesState("Washington Street, Pittsburgh, Pennsylvania, United States", "WA"),
  false,
);

const placed = choosePlacement(
  [
    { lat: 39.96, lon: -83.0, label: "100 Grant Street, Columbus, Ohio, United States" },
    {
      lat: 40.44,
      lon: -79.99,
      label: "100 Grant Street, Pittsburgh, Allegheny County, Pennsylvania, United States",
    },
  ],
  "Allegheny",
  "PA",
);
assert.equal(placed?.lat, 40.44);

const numbered = choosePlacement(
  [
    {
      lat: 1,
      lon: 1,
      label: "Allegheny County Courthouse, 414 Grant Street, Pittsburgh, PA, United States",
    },
    {
      lat: 2,
      lon: 2,
      label: "100 Grant Street, Coraopolis, Allegheny County, PA, United States",
    },
  ],
  "Allegheny",
  "PA",
  "100 Grant Street",
);
assert.equal(numbered?.lat, 2);

assert.equal(
  choosePlacement(
    [{ lat: 39.96, lon: -83.0, label: "100 Grant Street, Columbus, Ohio, United States" }],
    "Allegheny",
    "PA",
  ),
  null,
);

const home = { lat: 40.0, lon: -80.0 };
const nearby = { lat: 40.05, lon: -80.0 };
const far = { lat: 41.2, lon: -80.0 };
const nearMiles = milesBetween(home, nearby);
const farMiles = milesBetween(home, far);
assert.equal(insideRadius(nearMiles, 10), true);
assert.equal(insideRadius(farMiles, 10), false);
assert.equal(insideRadius(0, 10), true);
assert.equal(formatMiles(0.04), "under 0.1 mi");

assert.equal(clampRadius(10), 10);
assert.equal(clampRadius(0), null);
assert.equal(clampRadius(101), null);
assert.equal(looksLikeZipList("15235, 15147"), true);
assert.equal(looksLikeZipList("Allegheny"), false);

const zipParams = {
  radiusMi: 10,
  feeds: [
    {
      id: "f1",
      name: "East",
      kind: "online",
      url: "https://example.com/stream",
      deviceId: "default",
      county: "15235, 15147",
      state: "PA",
    },
  ],
};
assert.match(feedsSaveError(zipParams) ?? "", /zip code/);

const okParams = {
  radiusMi: 10,
  feeds: [
    {
      id: "f1",
      name: "East",
      kind: "online",
      url: "https://example.com/stream",
      deviceId: "default",
      county: "Allegheny",
      state: "Pennsylvania",
    },
    {
      id: "f2",
      name: "Scanner",
      kind: "audio-in",
      url: "",
      deviceId: "default",
      county: "Allegheny",
      state: "PA",
    },
  ],
};
assert.equal(feedsSaveError(okParams), null);
assert.match(feedsSaveError({ radiusMi: 10, feeds: [] }) ?? "", /at least one feed/);
assert.match(
  feedsSaveError({
    radiusMi: 10,
    feeds: [
      {
        id: "f1",
        name: "East",
        kind: "online",
        url: "file:///tmp/a.mp3",
        county: "Allegheny",
        state: "PA",
      },
    ],
  }) ?? "",
  /http/,
);

const preview = readCall(previewTranscript());
assert.equal(preview?.dispatchType, "Structure fire");
assert.equal(preview?.heardAddress, "12245 Frankstown Road");
assert.equal(
  transcriptText([
    { text: "Engine 12, structure fire," },
    { text: "100 Grant Street." },
  ]),
  "Engine 12, structure fire, 100 Grant Street.",
);
assert.equal(hitId("feed-1", preview!), "feed-1:structure-fire:12245-frankstown-road");

const responding = readTransmission(
  "Engine 12 responding, structure fire, 12245 Frankstown Road.",
);
assert.equal(responding.callingUnitId, "Engine 12");
assert.equal(responding.units[0]?.status, "responding");
assert.equal(responding.heardAddress, "12245 Frankstown Road");
assert.equal(responding.dispatchType, "Structure fire");

const assigned = readTransmission("Engine 12, structure fire, 12245 Frankstown Road.");
assert.equal(assigned.callingUnitId, null);
assert.equal(assigned.units[0]?.status, "dispatched");

const onScene = readTransmission("Engine 12 on scene. Smoke showing from the second floor.");
assert.equal(onScene.callingUnitId, "Engine 12");
assert.equal(onScene.units[0]?.status, "on-scene");
assert.equal(onScene.heardAddress, null);

for (const line of ["Engine 12 cleared.", "Engine 12 available.", "Engine 12 left the scene."]) {
  const released = readTransmission(line);
  assert.equal(released.units[0]?.id, "Engine 12", line);
  assert.equal(released.units[0]?.status, "clear", line);
}

let open: OpenIncident[] = [];
const firstId = nextIncidentId("feed-1", { dispatchType: "Structure fire", heardAddress: "12245 Frankstown Road" }, open);
const created = foldTransmission(open, responding, firstId);
assert.equal(created.action, "created");
assert.equal(created.incidentId, "feed-1:structure-fire:12245-frankstown-road");
assert.deepEqual(created.open[0]?.units, [{ id: "Engine 12", status: "responding" }]);

const joined = foldTransmission(created.open, onScene, "should-not-create");
assert.equal(joined.action, "joined");
assert.equal(joined.incidentId, created.incidentId);
assert.equal(joined.open.length, 1);
assert.equal(joined.open[0]?.units[0]?.status, "on-scene");

const otherUnit = readTransmission("Medic 4 on scene.");
const separate = foldTransmission(joined.open, otherUnit, "medic");
assert.equal(separate.action, "ignored");
assert.equal(separate.open.length, 1);

const stillThere = readTransmission("Engine 12 responding, vehicle fire, 10 Main Street.");
const stays = foldTransmission(joined.open, stillThere, "new-address");
assert.equal(stays.action, "joined");
assert.equal(stays.incidentId, created.incidentId);
assert.equal(stays.open.length, 1);

const cleared = foldTransmission(joined.open, readTransmission("Engine 12 cleared."), "nope");
assert.equal(cleared.action, "joined");
assert.equal(cleared.incidentId, created.incidentId);
assert.deepEqual(cleared.open[0]?.units, []);

const again = readTransmission("Engine 12 responding, structure fire, 12245 Frankstown Road.");
const secondId = nextIncidentId(
  "feed-1",
  { dispatchType: "Structure fire", heardAddress: "12245 Frankstown Road" },
  cleared.open,
);
const reopened = foldTransmission(cleared.open, again, secondId);
assert.equal(reopened.action, "created");
assert.equal(reopened.incidentId, "feed-1:structure-fire:12245-frankstown-road:2");
assert.equal(reopened.open.length, 2);
assert.deepEqual(reopened.open[0]?.units, []);
assert.deepEqual(reopened.open[1]?.units, [{ id: "Engine 12", status: "responding" }]);

assert.equal(looksLikeUnitId("Engine 12"), true);
assert.equal(personFromVoice("Engine 12", []), null);
let people = learnPerson([], "Engine 12", "Engine 12");
assert.equal(people.length, 0);
people = learnPerson(people, "voice-a", "Engine 12");
const personA = personFromVoice("voice-a", people);
assert.ok(personA?.startsWith("person:"));
people = learnPerson(people, "voice-a", "Ladder 3");
assert.equal(personFromVoice("voice-a", people), personA);
assert.deepEqual(people[0]?.unitIds, ["Engine 12", "Ladder 3"]);
assert.match(personPhrase(people[0] ?? null) ?? "", /heard on Engine 12, Ladder 3/);
people = learnPerson(people, "voice-b", "Engine 12");
const personB = personFromVoice("voice-b", people);
assert.notEqual(personA, personB);
assert.equal(people.filter((person) => person.unitIds.includes("Engine 12")).length, 2);

const labeled = formatRadioTranscript([
  { callingUnitId: "Engine 12", personLabel: null, text: respondingText(responding) },
  { callingUnitId: "Engine 12", personLabel: null, text: "Engine 12 on scene. Smoke showing from the second floor." },
]);
assert.match(labeled, /Unit Engine 12/);
assert.match(labeled, /Person: not learned/);
assert.equal(labeled.includes("Person: Engine 12"), false);

function respondingText(heard: TransmissionRead): string {
  return heard.heardAddress
    ? `Engine 12 responding, structure fire, ${heard.heardAddress}.`
    : "Engine 12 responding.";
}

console.log("safety checks ok");
