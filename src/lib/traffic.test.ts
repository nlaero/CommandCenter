import assert from "node:assert/strict";
import { trafficEventsToBoardAlerts } from "./boardAlerts.ts";
import {
  collectTraffic,
  compassNetworks,
  feedsFor,
  milesBetween,
  regionBounds,
  REGION_MILES,
  zoomToFit,
} from "./traffic.ts";

const pennHills = { lat: 40.475, lon: -79.835 };
const pennBounds = regionBounds(pennHills.lat, pennHills.lon);
const pennFeeds = feedsFor(pennBounds);

assert.ok(pennFeeds.includes("penndot"));
assert.ok(pennFeeds.includes("ohgo"));
assert.ok(!pennFeeds.includes("iowa"));
assert.ok(!pennFeeds.includes("open511"));
assert.ok(!pennFeeds.includes("compass"));
assert.deepEqual(compassNetworks(pennBounds), []);

const baltimore = feedsFor(regionBounds(39.29, -76.61));
assert.ok(baltimore.includes("chart"));
assert.ok(baltimore.includes("penndot"));
assert.ok(!baltimore.includes("iowa"));

assert.deepEqual(feedsFor(regionBounds(41.59, -93.62)), ["iowa"]);
assert.deepEqual(feedsFor(regionBounds(49.25, -123.12)), ["open511"]);
assert.deepEqual(feedsFor(regionBounds(43.66, -70.26)), ["compass"]);
assert.deepEqual(compassNetworks(regionBounds(43.66, -70.26)), ["Maine", "NewHampshire", "Vermont"]);
assert.deepEqual(feedsFor(regionBounds(39.74, -104.99)), []);

const far = { lat: pennHills.lat - 2.2, lon: pennHills.lon };
assert.ok(milesBetween(pennHills.lat, pennHills.lon, far.lat, far.lon) > REGION_MILES);

const fitted = zoomToFit(pennBounds, 640, 420);
const nw = { x: 0, y: 0 };
void nw;
assert.ok(fitted.zoom >= 3 && fitted.zoom <= 11);
assert.ok(Math.abs(fitted.lat - pennHills.lat) < 0.2);

const penndot = collectTraffic({
  ...pennHills,
  label: "Penn Hills, Pennsylvania",
  secrets: { penndotUser: "road", penndotPassword: "secret", ohgoKey: "key" },
  bodies: {
    penndotEvents: {
      json: {
        Values: [
          {
            EventID: 581,
            EventType: "roadwork",
            Facility: "HITE RD",
            Direction: "eastbound",
            FromLocLatLong: "40.566278,-79.795637",
            ToLocLatLong: "40.570501,-79.790632",
            LaneStatus: "lane restriction",
            Description: "Roadwork on HITE RD eastbound. There is a lane restriction.",
            LastUpdate: "2019-08-27 14:31:55",
            ActualDateTimeOpened: "",
          },
          {
            EventID: 9,
            EventType: "crash",
            Facility: "I-76",
            FromLocLatLong: "41.900000,-77.000000",
            LaneStatus: "closed",
            Description: "Too far east to be in this region.",
          },
          {
            EventID: 10,
            EventType: "crash",
            Facility: "US 22",
            FromLocLatLong: "40.450000,-79.800000",
            LaneStatus: "open",
            ActualDateTimeOpened: "2019-08-27 15:00:00",
            Description: "Reopened crash.",
          },
          {
            EventID: 11,
            EventType: "disabled vehicle",
            Facility: "PA 8",
            FromLocLatLong: "40.480000,-79.840000",
            LaneStatus: "shoulder closed",
            Description: "Disabled vehicle on the shoulder.",
          },
        ],
      },
    },
    penndotWinter: {
      json: {
        Values: [
          {
            RoadSectionID: 1,
            Facility: "I-376",
            CountyName: "ALLEGHENY",
            Condition: "Clear",
            FromLocLatLong: "40.470000,-79.850000",
            ToLocLatLong: "40.490000,-79.820000",
          },
          {
            RoadSectionID: 2,
            Facility: "I-79",
            CountyName: "ALLEGHENY",
            Condition: "Icy",
            FromLocLatLong: "40.520000,-80.020000",
            ToLocLatLong: "40.560000,-80.080000",
            LastUpdate: "2026-01-15 06:00",
          },
          {
            RoadSectionID: 3,
            Facility: "US 30",
            Condition: "Wet with Freezing Conditions",
            FromLocLatLong: "40.430000,-79.900000",
            ToLocLatLong: "40.440000,-79.880000",
          },
        ],
      },
    },
    ohgoIncidents: {
      json: {
        Results: [
          {
            Id: "oh-1",
            Latitude: 40.9,
            Longitude: -80.7,
            RouteName: "I-80",
            Direction: "Westbound",
            Category: "Accident",
            RoadStatus: "Partial Closure",
            Description: "Crash on I-80 westbound.",
          },
          {
            Id: "oh-far",
            Latitude: 41.5,
            Longitude: -83.0,
            Description: "Far Ohio crash.",
            RoadStatus: "Closed",
          },
        ],
      },
    },
    ohgoDelays: {
      json: {
        Results: [
          {
            Id: "delay-1",
            Latitude: 40.85,
            Longitude: -80.55,
            RouteName: "I-76",
            DelayTime: 12,
            CurrentAvgSpeed: 25,
            NormalAvgSpeed: 65,
            Description: "Slowdown on I-76.",
          },
          {
            Id: "delay-small",
            Latitude: 40.8,
            Longitude: -80.5,
            RouteName: "I-680",
            DelayTime: 1,
            CurrentAvgSpeed: 62,
            NormalAvgSpeed: 65,
            Description: "Small slowdown.",
          },
        ],
      },
    },
  },
});

assert.equal(penndot.traffic.label, "Penn Hills, Pennsylvania");
assert.equal(penndot.traffic.radiusMi, 80);
assert.equal(penndot.traffic.routineOmitted, 1);
const byId = Object.fromEntries(penndot.traffic.events.map((event) => [event.id, event]));
assert.equal(byId["penndot:581"]?.affectsTravel, true);
assert.equal(byId["penndot:581"]?.severity, "warn");
assert.equal(byId["penndot:581"]?.kind, "roadwork");
assert.equal(byId["penndot:9"], undefined);
assert.equal(byId["penndot:10"], undefined);
assert.equal(byId["penndot:11"]?.affectsTravel, false);
assert.equal(byId["penndot-winter:2"]?.severity, "alert");
assert.equal(byId["penndot-winter:2"]?.kind, "condition");
assert.equal(byId["penndot-winter:3"]?.severity, "warn");
assert.equal(byId["ohgo:oh-1"]?.affectsTravel, true);
assert.equal(byId["ohgo:oh-far"], undefined);
assert.equal(byId["ohgo-delay:delay-1"]?.severity, "alert");
assert.equal(byId["ohgo-delay:delay-1"]?.kind, "delay");
assert.equal(byId["ohgo-delay:delay-small"]?.affectsTravel, false);
assert.ok(penndot.attribution.includes("PennDOT 511"));
assert.ok(penndot.attribution.includes("OHGO"));
assert.ok(penndot.attribution.includes("Esri basemap"));

const alerts = trafficEventsToBoardAlerts({
  sourceId: "src",
  sourceType: "traffic.roads",
  sourceLabel: "Traffic",
  events: penndot.traffic.events,
});
assert.ok(alerts.some((alert) => alert.id === "src::penndot:581"));
assert.ok(alerts.some((alert) => alert.id === "src::ohgo-delay:delay-1" && alert.severity === "alert"));
assert.ok(!alerts.some((alert) => alert.id === "src::penndot:11"));
assert.ok(!alerts.some((alert) => alert.id === "src::ohgo-delay:delay-small"));

const needsCreds = collectTraffic({ ...pennHills });
assert.ok(needsCreds.traffic.feeds.some((feed) => feed.id === "penndot" && feed.status === "needs-credentials"));
assert.ok(needsCreds.traffic.feeds.some((feed) => feed.id === "ohgo" && feed.status === "needs-credentials"));
assert.match(needsCreds.note, /PennDOT username/);
assert.match(needsCreds.note, /OHGO/);
assert.equal(needsCreds.traffic.events.length, 0);

const none = collectTraffic({ lat: 39.74, lon: -104.99 });
assert.equal(none.traffic.feeds.length, 0);
assert.match(none.note, /No free real-time incident feed/);
assert.equal(none.attribution, "Esri basemap");

const chart = collectTraffic({
  lat: 39.29,
  lon: -76.61,
  bodies: {
    chartEvents: {
      json: {
        data: [
          {
            id: "signal",
            type: 249,
            description: "Action Event @ MD 77",
            lat: 39.3,
            lon: -76.6,
            incidentType: "Other",
            trafficAlert: false,
            lanes: [],
          },
          {
            id: "crash",
            type: 2,
            description: "Incident @ I-95",
            lat: 39.3,
            lon: -76.62,
            incidentType: "Personal Injury",
            county: "Baltimore",
            direction: "North",
            trafficAlert: true,
            lanes: [{ laneDescription: "L1", laneType: "Traffic Lane", laneStatus: "closed" }],
            lanesStatus: "1 lane closed",
            lastCachedDataUpdateTime: 1794641593000,
          },
        ],
      },
    },
    chartClosures: {
      json: {
        data: [
          {
            id: "ramp",
            description: "Active Closure @ US-15",
            lat: 39.4,
            lon: -77.4,
            county: "Frederick",
            closureStartDate: -1,
            lanesClosed: "ramp closed",
            lanes: [
              { laneDescription: "Rt OffRamp", laneType: "Right Off Ramp", laneStatus: "closed" },
              { laneDescription: "L1", laneType: "Traffic Lane", laneStatus: "open" },
            ],
          },
          {
            id: "shoulder",
            description: "Shoulder only",
            lat: 39.2,
            lon: -76.7,
            closureStartDate: -1,
            lanes: [{ laneDescription: "RS", laneType: "Shoulder", laneStatus: "closed" }],
          },
        ],
      },
    },
  },
});
const chartIds = chart.traffic.events.map((event) => event.id);
assert.ok(!chartIds.includes("chart:signal"));
assert.equal(chart.traffic.events.find((event) => event.id === "chart:crash")?.affectsTravel, true);
assert.equal(chart.traffic.events.find((event) => event.id === "chart-closure:ramp")?.severity, "warn");
assert.ok(!chartIds.includes("chart-closure:shoulder"));
assert.ok(chart.traffic.feeds.some((feed) => feed.id === "chart" && feed.status === "live"));

const iowa = collectTraffic({
  lat: 41.6,
  lon: -93.6,
  bodies: {
    iowaEvents: {
      json: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-93.6, 41.6] },
            properties: {
              ID: "IA-1",
              STYLE: "closure",
              headline: "I-80 closed",
              phrase: "Closed",
              Route: "I-80",
              linktxt: "https://511ia.org/event/IA-1",
            },
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-93.61, 41.61] },
            properties: { ID: "IA-later", STYLE: "future_event", headline: "Next month" },
          },
        ],
      },
    },
    iowaConditions: {
      json: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [[-93.6, 41.6], [-93.59, 41.6]] },
            properties: {
              SEGMENT_ID: 9,
              ROAD_CONDITION: "Seasonal",
              PRIMARY_LATITUDE: 41.6,
              PRIMARY_LONGITUDE: -93.6,
              ROUTE_NAME: "I-35",
            },
          },
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [[-93.62, 41.62]] },
            properties: {
              SEGMENT_ID: 10,
              ROAD_CONDITION: "Ice",
              PRIMARY_LATITUDE: 41.62,
              PRIMARY_LONGITUDE: -93.62,
              ROUTE_NAME: "US 65",
            },
          },
        ],
      },
    },
  },
});
assert.equal(iowa.traffic.events.find((event) => event.id === "iowa:IA-1")?.severity, "alert");
assert.equal(iowa.traffic.events.find((event) => event.id === "iowa:IA-1")?.detailUrl, "https://511ia.org/event/IA-1");
assert.ok(!iowa.traffic.events.some((event) => event.id.includes("later")));
assert.equal(iowa.traffic.routineOmitted, 1);
assert.equal(iowa.traffic.events.find((event) => event.id === "iowa-road:10")?.kind, "condition");

const bc = collectTraffic({
  lat: 49.25,
  lon: -123.12,
  bodies: {
    open511: {
      json: {
        events: [
          {
            id: "drivebc.ca/rest",
            headline: "CONSTRUCTION",
            severity: "MINOR",
            event_type: "CONSTRUCTION",
            description: "Rest area closed.",
            geography: { type: "Point", coordinates: [-123.1, 49.25] },
            roads: [{ name: "Highway 1", direction: "BOTH", state: "ALL_LANES_OPEN" }],
            url: "https://api.open511.gov.bc.ca/events/drivebc.ca/rest",
          },
          {
            id: "drivebc.ca/shut",
            headline: "CLOSED",
            severity: "MAJOR",
            event_type: "INCIDENT",
            description: "Highway closed.",
            geography: { type: "LineString", coordinates: [[-123.2, 49.28], [-123.05, 49.22]] },
            roads: [{ name: "Highway 99", state: "CLOSED" }],
          },
          {
            id: "drivebc.ca/far",
            headline: "INCIDENT",
            severity: "MAJOR",
            event_type: "INCIDENT",
            geography: { type: "Point", coordinates: [-120, 51] },
            roads: [{ state: "CLOSED" }],
          },
        ],
      },
    },
  },
});
assert.equal(bc.traffic.events.find((event) => event.id === "open511:drivebc.ca/rest")?.affectsTravel, false);
assert.equal(bc.traffic.events.find((event) => event.id === "open511:drivebc.ca/shut")?.severity, "alert");
assert.ok(!bc.traffic.events.some((event) => event.id.includes("far")));

const maine = collectTraffic({
  lat: 43.66,
  lon: -70.26,
  bodies: {
    compass: {
      text: `<status xmlns="http://its.gov/c2c_icd"><incidentData><incident id="ME26-003760"><desc>Brunswick Route 1 northbound Right Lane closed due to Bridge Maintenance use caution and expect delays</desc><startLocation><lat>43813515</lat><lon>-70303726</lon><roadway>US-1 SB</roadway><direction>South</direction></startLocation><status>Verified</status><severity>Medium</severity><affectedLanesDescription>Right lane closed</affectedLanesDescription><affectedLanes2><lane><isBlocked>true</isBlocked></lane></affectedLanes2></incident><incident id="ME-cleared"><desc>Cleared earlier</desc><lat>43660000</lat><lon>-70260000</lon><status>Cleared</status></incident></incidentData></status>`,
    },
  },
});
const lane = maine.traffic.events.find((event) => event.id === "compass:ME26-003760");
assert.ok(lane);
assert.equal(lane?.affectsTravel, true);
assert.ok(Math.abs((lane?.lat ?? 0) - 43.813515) < 0.0001);
assert.ok(Math.abs((lane?.lon ?? 0) + 70.303726) < 0.0001);
assert.ok(!maine.traffic.events.some((event) => event.id.includes("cleared")));

const refused = collectTraffic({
  ...pennHills,
  secrets: { penndotUser: "road", penndotPassword: "nope" },
  bodies: {
    penndotEvents: { error: "refused the saved credentials." },
    penndotWinter: { error: "refused the saved credentials." },
  },
});
assert.equal(refused.traffic.feeds.find((feed) => feed.id === "penndot")?.status, "error");
assert.match(refused.traffic.feeds.find((feed) => feed.id === "penndot")?.detail ?? "", /refused/);
assert.doesNotMatch(refused.note, /nope/);

console.log("traffic.test.ts ok");
