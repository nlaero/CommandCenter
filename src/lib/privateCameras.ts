import { assertHttpUrl } from "./streamMedia.ts";

export type PrivateBrand = {
  id: string;
  title: string;
  detail: string;
  placeholder: string;
  steps: string[];
};

export const PRIVATE_BRANDS: PrivateBrand[] = [
  {
    id: "custom",
    title: "A link I already have",
    detail: "Web, app, or a stream address from the camera system",
    placeholder: "https://…/playlist.m3u8",
    steps: [
      "Copy the stream link from the camera, the recorder, or the app.",
      "Use an HLS playlist (.m3u8), a video file, a still image, or a YouTube link.",
      "A UDP or RTSP address does not play here. The camera system has to offer one of those links first.",
      "Paste it below. Sound starts muted. A still image has no captions.",
    ],
  },
  {
    id: "frigate",
    title: "Frigate",
    detail: "Still image or the HLS playlist from go2rtc",
    placeholder: "http://frigate.local:5000/api/front/latest.jpg",
    steps: [
      "Open Frigate on this network and pick the camera.",
      "For a still, copy the latest.jpg address for that camera.",
      "For video, open the stream page and copy the HLS playlist.",
      "Paste that link below.",
    ],
  },
  {
    id: "go2rtc",
    title: "go2rtc",
    detail: "HLS playlist from the local stream page",
    placeholder: "http://127.0.0.1:1984/api/stream.m3u8?src=front",
    steps: [
      "Open go2rtc on this network. The web page is usually port 1984.",
      "Find the stream name.",
      "Copy its HLS link.",
      "Paste it below.",
    ],
  },
  {
    id: "blueiris",
    title: "Blue Iris",
    detail: "JPEG, MJPEG, or HLS from the local web server",
    placeholder: "http://blueiris.local:81/image/front",
    steps: [
      "Open Blue Iris in a browser on this network.",
      "A still uses the camera's JPEG address, /image/<shortname>.",
      "A moving picture uses the MJPEG address or the HLS link Blue Iris shows.",
      "Paste the http link below. Leave the password out of the link when you can. The link is saved with the board on this computer.",
    ],
  },
  {
    id: "scrypted",
    title: "Scrypted",
    detail: "Local snapshot or HLS from Scrypted",
    placeholder: "http://scrypted.local/…",
    steps: [
      "Open Scrypted on this network.",
      "Open the camera and its snapshot or stream settings.",
      "Copy the local snapshot or HLS address it publishes.",
      "Paste that link below. A Ring or Nest sign-in stays in Scrypted.",
    ],
  },
  {
    id: "synology",
    title: "Synology Surveillance Station",
    detail: "Snapshot or HLS from Surveillance Station",
    placeholder: "https://nas.local/…",
    steps: [
      "Open Surveillance Station in a browser on this network.",
      "Open the camera's live view or snapshot sharing.",
      "Copy the snapshot or HLS address it gives you.",
      "Paste that link below.",
    ],
  },
  {
    id: "unifi",
    title: "UniFi Protect",
    detail: "Through Frigate, go2rtc, or Scrypted",
    placeholder: "http://127.0.0.1:1984/api/stream.m3u8?src=protect",
    steps: [
      "In Protect, open the camera settings and turn on an RTSP stream if you want one.",
      "This panel does not play RTSP. Add that camera to Frigate, go2rtc, or Scrypted.",
      "Copy the HLS playlist or snapshot that bridge shows.",
      "Paste that link below.",
    ],
  },
  {
    id: "reolink",
    title: "Reolink",
    detail: "JPEG snapshot, or HLS from a recorder",
    placeholder: "http://192.168.1.20/cgi-bin/api.cgi?cmd=Snap&channel=0",
    steps: [
      "On the camera or NVR, note the address you already open in a browser.",
      "A still image is that camera's Snap link, which returns a JPEG.",
      "An RTSP link does not play here. Run it through Frigate or go2rtc and copy the HLS playlist.",
      "Paste the JPEG or playlist below. Prefer a link without the camera password. The link is saved with the board on this computer.",
    ],
  },
  {
    id: "hikvision",
    title: "Hikvision, Amcrest, or Dahua",
    detail: "HTTP snapshot, or HLS from a recorder",
    placeholder: "http://192.168.1.30/…/picture",
    steps: [
      "Use the camera's HTTP snapshot if it has one. That address returns a JPEG.",
      "An RTSP link does not play here. Point Frigate or go2rtc at the camera and copy the HLS playlist.",
      "Paste the JPEG or playlist below.",
      "Leave the password out of the link when the recorder can show the stream without it. The link is saved with the board on this computer.",
    ],
  },
  {
    id: "axis",
    title: "Axis",
    detail: "VAPIX JPEG or MJPEG",
    placeholder: "http://192.168.1.40/axis-cgi/jpg/image.cgi",
    steps: [
      "A still is http://<camera>/axis-cgi/jpg/image.cgi.",
      "A moving picture is http://<camera>/axis-cgi/mjpg/video.cgi.",
      "Paste that link below.",
      "If the camera asks you to sign in, use the snapshot or stream your recorder publishes instead of putting the password in the link.",
    ],
  },
  {
    id: "cloud",
    title: "Ring, Nest, or Arlo",
    detail: "No direct link. Use a local bridge.",
    placeholder: "http://scrypted.local/…",
    steps: [
      "These brands do not give Command Center a stream link.",
      "On this network, connect the camera with Scrypted or Home Assistant using that brand's own integration.",
      "Copy the local snapshot or HLS address that bridge shows.",
      "Paste it below. The brand password stays in that bridge, not in this board.",
    ],
  },
];

const BRAND_IDS = new Set(PRIVATE_BRANDS.map((brand) => brand.id));

export function brandById(value: unknown): PrivateBrand {
  const id = typeof value === "string" ? value : "";
  return PRIVATE_BRANDS.find((brand) => brand.id === id) ?? PRIVATE_BRANDS[0];
}

export function brandId(value: unknown): string {
  const id = typeof value === "string" ? value : "";
  return BRAND_IDS.has(id) ? id : "custom";
}

const BLOCKED_SCHEMES = new Set(["rtsp", "rtsps", "udp", "rtp", "rtmp", "rtmps", "srt"]);

/** The existing panel plays http(s) HLS, a file, a still, or YouTube. UDP and RTSP stay on the camera system. */
export function streamLinkError(
  value: unknown,
  empty = "Paste the stream link from the camera system.",
): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return empty;
  const scheme = raw.split(":")[0]?.toLowerCase() ?? "";
  if (BLOCKED_SCHEMES.has(scheme)) {
    return "This panel plays an HLS playlist, a video file, a still image, or a YouTube link. A UDP or RTSP address stays on the camera system until it gives you one of those.";
  }
  try {
    assertHttpUrl(raw);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Enter an http or https link.";
  }
}

export function canonicalStreamUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return assertHttpUrl(raw);
}
