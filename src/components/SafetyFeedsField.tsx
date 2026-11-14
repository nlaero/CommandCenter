import { useEffect, useState } from "react";
import { isPennHillsPreset, PENN_HILLS_FEED } from "../lib/broadcastifyPreset";
import { broadcastifyAudioInputs, parseFeedOwnerInputId } from "../lib/feedCaptions";
import { listAudioInputs } from "../lib/safetyListen";
import { blankFeed, canonicalState, readFeeds, US_STATES, type SafetyFeed } from "../lib/safety";

type Props = {
  params: Record<string, unknown>;
  sources?: Record<string, { type: string; params?: Record<string, unknown> } | undefined>;
  disabled?: boolean;
  onChange: (params: Record<string, unknown>) => void;
};

export function SafetyFeedsField({ params, sources = {}, disabled, onChange }: Props) {
  const feeds = readFeeds(params.feeds);
  const ownerInputs = broadcastifyAudioInputs(sources);
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

  function write(next: SafetyFeed[]) {
    onChange({ ...params, feeds: next });
  }

  function update(id: string, patch: Partial<SafetyFeed>) {
    write(feeds.map((feed) => (feed.id === id ? { ...feed, ...patch } : feed)));
  }

  return (
    <div className="safety-feeds">
      {feeds.map((feed, index) => (
        <div className="safety-feed-card" key={feed.id}>
          <div className="safety-feed-head">
            <span className="section-label">Feed {index + 1}</span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled || feeds.length === 1}
              onClick={() => write(feeds.filter((item) => item.id !== feed.id))}
            >
              Remove
            </button>
          </div>
          <div className="field">
            <label htmlFor={`${feed.id}-name`}>Name</label>
            <input
              id={`${feed.id}-name`}
              value={feed.name}
              disabled={disabled}
              placeholder="East dispatch"
              autoComplete="off"
              onChange={(event) => update(feed.id, { name: event.target.value })}
            />
          </div>
          <div className="safety-kind" role="group" aria-label="Feed kind">
            <button
              type="button"
              className={`location-choice${feed.kind === "online" ? " is-selected" : ""}`}
              disabled={disabled}
              onClick={() => update(feed.id, { kind: "online" })}
            >
              <span className="location-choice-mark" aria-hidden />
              <span>
                <strong>Online</strong>
                <span>A stream URL</span>
              </span>
            </button>
            <button
              type="button"
              className={`location-choice${feed.kind === "audio-in" ? " is-selected" : ""}`}
              disabled={disabled}
              onClick={() => update(feed.id, { kind: "audio-in" })}
            >
              <span className="location-choice-mark" aria-hidden />
              <span>
                <strong>Audio input</strong>
                <span>Jack, Bluetooth, or the sound card</span>
              </span>
            </button>
          </div>
          {feed.kind === "online" ? (
            <div className="field">
              <label htmlFor={`${feed.id}-url`}>Stream URL</label>
              <input
                id={`${feed.id}-url`}
                value={feed.url}
                disabled={disabled}
                placeholder="https://…"
                autoComplete="off"
                onChange={(event) => update(feed.id, { url: event.target.value })}
              />
              <div className="help">
                http or https. A short window is recorded on this computer. The feed is not
                rebroadcast.
              </div>
            </div>
          ) : (
            <div className="field">
              <label htmlFor={`${feed.id}-device`}>Audio input</label>
              <div className="safety-device-row">
                <select
                  id={`${feed.id}-device`}
                  value={feed.deviceId || "default"}
                  disabled={disabled}
                  onChange={(event) => {
                    const deviceId = event.target.value;
                    const device =
                      devices.find((item) => item.id === deviceId) ??
                      ownerInputs.find((item) => item.id === deviceId);
                    const patch: Partial<SafetyFeed> = {
                      deviceId,
                      deviceLabel: device?.label ?? feed.deviceLabel,
                    };
                    const ownerId = parseFeedOwnerInputId(deviceId);
                    const owner = ownerId ? sources[ownerId] : undefined;
                    if (owner && isPennHillsPreset(owner.params ?? {})) {
                      if (!feed.county.trim()) patch.county = PENN_HILLS_FEED.county;
                      if (!canonicalState(feed.state)) patch.state = "PA";
                    }
                    update(feed.id, patch);
                  }}
                >
                  {devices.some((device) => device.id === feed.deviceId) ||
                  ownerInputs.some((device) => device.id === feed.deviceId) ? null : (
                    <option value={feed.deviceId}>
                      {feed.deviceLabel || feed.deviceId || "Saved input"}
                    </option>
                  )}
                  <optgroup label="This computer">
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.label}
                      </option>
                    ))}
                  </optgroup>
                  {ownerInputs.length ? (
                    <optgroup label="Feed Owner captions">
                      {ownerInputs.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
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
              <div className="help">
                A microphone on this computer, or a Broadcastify Feed Owner source already added.
                That choice reads the panel's live captions. The relay address is kept with them
                and has no password. Playback starts muted.
              </div>
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
      ))}
      <div className="safety-feed-actions">
        <button
          type="button"
          className="btn"
          disabled={disabled || feeds.length >= 8}
          onClick={() => write([...feeds, blankFeed()])}
        >
          Add online feed
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled || feeds.length >= 8}
          onClick={() => write([...feeds, { ...blankFeed(), kind: "audio-in" }])}
        >
          Add audio input
        </button>
      </div>
    </div>
  );
}
