import type { AdapterDefinition } from "../types";

/** The twelve board sources added with the panel list in Settings. */
export const WATCH_ADAPTERS: AdapterDefinition[] = [
  {
    typeId: "rivers.nwps",
    category: "product",
    name: "River stage",
    description:
      "NOAA river gauges near the confirmed place: observed stage, flood category, and the forecast crest.",
    defaultWidget: "watch",
    defaultRefresh: "15m",
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "location",
        required: true,
        help: "GPS, network location, or another source on this device, or an address. Command Center confirms the place before you can save.",
      },
      {
        key: "radiusMi",
        label: "Radius (miles)",
        kind: "number",
        required: true,
        help: "Gauges inside this distance. Default is 25 miles.",
      },
    ],
  },
  {
    typeId: "storms.spc",
    category: "product",
    name: "Storm reports",
    description:
      "Storm Prediction Center day-one outlook and local storm reports inside the saved radius.",
    defaultWidget: "watch",
    defaultRefresh: "15m",
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "location",
        required: true,
        help: "Confirm the place. Reports outside the radius stay off this panel.",
      },
      {
        key: "radiusMi",
        label: "Radius (miles)",
        kind: "number",
        required: true,
        help: "Default is 50 miles. The outlook is shown when it covers this place.",
      },
    ],
  },
  {
    typeId: "lightning.glm",
    category: "product",
    name: "Lightning",
    description:
      "GOES-East lightning flashes from NOAA. The newest file only, limited to the saved radius.",
    defaultWidget: "watch",
    defaultRefresh: "90s",
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "location",
        required: true,
        help: "Flashes outside this place are dropped.",
      },
      {
        key: "radiusMi",
        label: "Radius (miles)",
        kind: "number",
        required: true,
        help: "Default is 30 miles.",
      },
    ],
  },
  {
    typeId: "agency.rss",
    category: "product",
    name: "Agency alerts",
    description: "A public alert feed you paste. There is no national directory of local agencies.",
    defaultWidget: "watch",
    defaultRefresh: "3m",
    fields: [
      {
        key: "label",
        label: "Name",
        kind: "string",
        required: false,
        placeholder: "Monroeville alerts",
      },
      {
        key: "url",
        label: "Alert feed URL",
        kind: "url",
        required: true,
        placeholder: "https://example.gov/RSSFeed.aspx?ModID=63",
        help: "Paste the agency's public RSS or Atom URL. Road incidents stay on the traffic panel.",
      },
    ],
  },
  {
    typeId: "transit.gtfs",
    category: "product",
    name: "Transit alerts",
    description:
      "GTFS-RT service alerts. Pittsburgh Regional Transit is filled in when the confirmed place is in that area.",
    defaultWidget: "watch",
    defaultRefresh: "90s",
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "location",
        required: true,
        help: "Used to decide whether the Pittsburgh bus and rail alert feeds apply.",
      },
      {
        key: "urls",
        label: "Alerts URLs",
        kind: "string",
        required: false,
        placeholder: "https://example.org/gtfsrt/alerts",
        help: "One GTFS-RT alerts URL per line. Leave this blank in the Pittsburgh area and the PRT bus and rail feeds are filled in. An optional token stays in the OS keyring.",
      },
      {
        key: "secret:transit.token",
        label: "Optional access token",
        kind: "secret",
        required: false,
        secret: true,
        help: "Only for an agency that requires one. Stored in the OS keyring, not in the board file.",
      },
    ],
  },
  {
    typeId: "tfr.faa",
    category: "product",
    name: "Flight restrictions",
    description:
      "FAA temporary flight restrictions. Shapes inside the radius, plus a short list of shapeless notices in this state.",
    defaultWidget: "watch",
    defaultRefresh: "10m",
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "location",
        required: true,
        help: "The FAA list is informational.",
      },
      {
        key: "radiusMi",
        label: "Radius (miles)",
        kind: "number",
        required: true,
        help: "Default is 80 miles.",
      },
    ],
  },
  {
    typeId: "nuclear.nrc",
    category: "product",
    name: "Nuclear event notices",
    description:
      "NRC event notices. Beaver Valley is pinned when it appears. The rest of the list is national.",
    defaultWidget: "watch",
    defaultRefresh: "30m",
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "location",
        required: false,
        help: "Optional. A confirmed place highlights notices for that state.",
      },
    ],
  },
  {
    typeId: "radiation.epa",
    category: "product",
    name: "Radiation",
    description:
      "The nearest EPA RadNet station. A reading is flagged only when it leaves that station's own recent range.",
    defaultWidget: "watch",
    defaultRefresh: "60m",
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "location",
        required: true,
        help: "Picks one station. Gaps in the public file are normal.",
      },
    ],
  },
  {
    typeId: "spills.uscg",
    category: "product",
    name: "Spill reports",
    description:
      "Coast Guard National Response Center caller reports for nearby counties. These are reports, not confirmed spills.",
    defaultWidget: "watch",
    defaultRefresh: "12h",
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "location",
        required: true,
        help: "County and state come from the confirmed place. Coordinates are used when a report has them.",
      },
      {
        key: "radiusMi",
        label: "Radius (miles)",
        kind: "number",
        required: true,
        help: "Neighboring counties inside this distance are included. Default is 40 miles.",
      },
    ],
  },
  {
    typeId: "disease.who",
    category: "product",
    name: "Disease notices",
    description: "A short global list of WHO disease outbreak notices. Not a map of local cases.",
    defaultWidget: "watch",
    defaultRefresh: "8h",
    fields: [
      {
        key: "limit",
        label: "How many notices",
        kind: "number",
        required: true,
        help: "The newest notices. Default is 12.",
      },
    ],
  },
  {
    typeId: "internet.ioda",
    category: "product",
    name: "Regional internet",
    description:
      "Internet outages for the confirmed place's state, from Georgia Tech IODA. Shown on this computer only.",
    defaultWidget: "watch",
    defaultRefresh: "10m",
    fields: [
      {
        key: "location",
        label: "Location",
        kind: "location",
        required: true,
        help: "The state is looked up from this place. The panel does not pull a country-wide or worldwide feed.",
      },
      {
        key: "asn",
        label: "Optional network number",
        kind: "string",
        required: false,
        placeholder: "AS7922",
        help: "An autonomous system number, if you want that network as well as the state.",
      },
    ],
  },
  {
    typeId: "alarms.home",
    category: "product",
    name: "Home alarms",
    description:
      "Smoke, gas, water, and door sensors from a Home Assistant hub or a broker already on this network. Nothing is polled until one is set.",
    defaultWidget: "watch",
    defaultRefresh: "30s",
    fields: [
      {
        key: "label",
        label: "Name",
        kind: "string",
        required: false,
        placeholder: "House",
      },
      {
        key: "link",
        label: "Connection",
        kind: "select",
        required: true,
        options: [
          { value: "homeassistant", label: "Home Assistant" },
          { value: "mqtt", label: "MQTT on this network" },
          { value: "both", label: "Home Assistant and MQTT" },
        ],
      },
      {
        key: "baseUrl",
        label: "Home Assistant URL",
        kind: "url",
        required: false,
        placeholder: "http://homeassistant.local:8123",
        help: "The local hub. The long-lived token stays in the OS keyring.",
      },
      {
        key: "secret:alarms.token",
        label: "Home Assistant token",
        kind: "secret",
        required: false,
        secret: true,
      },
      {
        key: "mqttHost",
        label: "MQTT host",
        kind: "string",
        required: false,
        placeholder: "mqtt://192.168.1.20",
        help: "A broker on this network. mqtt://host is enough.",
      },
      {
        key: "mqttPort",
        label: "MQTT port",
        kind: "number",
        required: false,
        help: "Default is 1883 when the host has no port.",
      },
      {
        key: "topic",
        label: "MQTT topic",
        kind: "string",
        required: false,
        placeholder: "homeassistant/#",
        help: "Leave blank for homeassistant/#.",
      },
    ],
  },
];
