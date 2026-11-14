import { useEffect, useState } from "react";
import {
  isCallsAudio,
  isFeedOwnerAudio,
  programAudioSources,
  syncSafetyFeeds,
} from "../lib/feedCaptions";
import { listAudioInputs } from "../lib/safetyListen";
import { blankFeed, readFeeds, US_STATES, type SafetyFeed } from "../lib/safety";

type Props = {
  params: Record<string, unknown>;
  sources?: Record<string, { type: string; params?: Record<string, unknown> } | undefined>;
  disabled?: boolean;
  onChange: (params: Record<string, unknown>) => void;
};

export function SafetyFeedsField({ params, sources = {}, disabled, onChange }: Props) {
  const feeds = readFeeds(params.feeds);
  const program = programAudioSources(sources);
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([
    { id: "default", label: "Default input" },
  ]);

  useEffect(() => {
    let cancelled = false;
    void listAudioInputs().then((next) => {
      if (!cancelled && next.length) setDevices(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceKey = program.map((item) => `${item.inputId}\t${item.label}\t${item.county}\t${item.state}`).join("\n");
  const feedKey = JSON.stringify(feeds);

  useEffect(() => {
    const next = syncSafetyFeeds(params, sources);
    if (JSON.stringify(readFeeds(next.feeds)) === feedKey) return;
    onChange(next);
    // The feed list is derived from configured sources. Re-run when those sources or the saved rows change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, feedKey]);

  function write(next: SafetyFeed[]) {
    onChange({ ...params, feeds: next });
  }

  function update(id: string, patch: Partial<SafetyFeed>) {
    write(feeds.map((feed) => (feed.id === id ? { ...feed, ...patch } : feed)));
  }

  return (
    <div className="safety-feeds">
      {feeds.map((feed) => {
        const linked = program.find((item) => item.inputId === feed.deviceId);
        const computer = !linked;
        return (
          <div className="safety-feed-card" key={feed.id}>
            <div className="safety-feed-head">
              <span className="section-label">{linked ? linked.label : "This computer"}</span>
              {computer ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={disabled || feeds.length === 1}
                  onClick={() => write(feeds.filter((item) => item.id !== feed.id))}
                >
                  Remove
                </button>
              ) : (
                <label className="safety-listen">
                  <input
                    type="checkbox"
                    checked={feed.listen !== false}
                    disabled={disabled}
                    onChange={(event) => update(feed.id, { listen: event.target.checked })}
                  />
                  Listen
                </label>
              )}
            </div>
            <div className="field">
              <label htmlFor={`${feed.id}-name`}>Name</label>
              <input
                id={`${feed.id}-name`}
                value={feed.name}
                disabled={disabled}
                placeholder={linked?.label ?? "Scanner"}
                autoComplete="off"
                onChange={(event) => update(feed.id, { name: event.target.value })}
              />
            </div>
            {computer ? (
              <div className="field">
                <label htmlFor={`${feed.id}-device`}>Audio input</label>
                <div className="safety-device-row">
                  <select
                    id={`${feed.id}-device`}
                    value={feed.deviceId || "default"}
                    disabled={disabled}
                    onChange={(event) => {
                      const deviceId = event.target.value;
                      const device = devices.find((item) => item.id === deviceId);
                      update(feed.id, {
                        kind: "audio-in",
                        url: "",
                        deviceId,
                        deviceLabel: device?.label ?? feed.deviceLabel,
                      });
                    }}
                  >
                    {devices.some((device) => device.id === feed.deviceId) ? null : (
                      <option value={feed.deviceId}>
                        {feed.deviceLabel || "Saved input"}
                      </option>
                    )}
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn"
                    disabled={disabled}
                    onClick={() => {
                      void listAudioInputs().then(setDevices);
                    }}
                  >
                    Refresh
                  </button>
                </div>
                <div className="help">A microphone, jack, or Bluetooth radio on this computer.</div>
              </div>
            ) : (
              <div className="help">
                {isFeedOwnerAudio(feed)
                  ? "Feed Owner audio and the captions from that panel. Playback starts muted, and the captions stay on while the sound is off."
                  : isCallsAudio(feed)
                    ? "Call clips from this Calls source. Playback starts muted. Captions are read on this computer."
                    : "Audio from this source. Playback starts muted."}
              </div>
            )}
            <div className="safety-feed-grid">
              <div className="field">
                <label htmlFor={`${feed.id}-county`}>County</label>
                <input
                  id={`${feed.id}-county`}
                  value={feed.county}
                  disabled={disabled}
                  placeholder="Allegheny"
                  autoComplete="off"
                  onChange={(event) => update(feed.id, { county: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor={`${feed.id}-state`}>State</label>
                <select
                  id={`${feed.id}-state`}
                  value={feed.state}
                  disabled={disabled}
                  onChange={(event) => update(feed.id, { state: event.target.value })}
                >
                  <option value="">Select…</option>
                  {US_STATES.some((item) => item.code === feed.state) || !feed.state ? null : (
                    <option value={feed.state}>{feed.state}</option>
                  )}
                  {US_STATES.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="help">
              The county and state this feed covers. A street heard on the air is placed there. Not a
              zip code list.
            </div>
          </div>
        );
      })}
      {program.length === 0 ? (
        <div className="help">
          No audio source is set up yet. Add Broadcastify Feed Owner or Broadcastify Calls, then
          open this source again. Nearby alerts do not take a scanner web address.
        </div>
      ) : null}
      <div className="safety-feed-actions">
        <button
          type="button"
          className="btn"
          disabled={disabled || feeds.length >= 24}
          onClick={() => write([...feeds, { ...blankFeed(), kind: "audio-in" }])}
        >
          Add audio input
        </button>
      </div>
    </div>
  );
}
