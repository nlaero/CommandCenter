import {
  WEATHER_MAPS,
  readMapCount,
  readMapRotateSec,
  readRotateMaps,
  readWeatherMaps,
  type WeatherMapId,
} from "../lib/weatherMaps";

type Props = {
  params: Record<string, unknown>;
  disabled?: boolean;
  help?: string;
  onChange: (params: Record<string, unknown>) => void;
};

const ROTATE_PRESETS = [15, 30, 60, 300];

export function WeatherMapsField({ params, disabled, help, onChange }: Props) {
  const selected = readWeatherMaps(params);
  const count = readMapCount(params, selected);
  const rotate = readRotateMaps(params);
  const seconds = readMapRotateSec(params);

  function write(next: Partial<Record<string, unknown>>, maps = selected) {
    const chosen = maps.length ? maps : selected;
    const rawCount = next.mapCount ?? params.mapCount ?? chosen.length;
    const capped = Math.min(Math.max(1, Number(rawCount) || 1), Math.max(1, chosen.length));
    onChange({
      ...params,
      ...next,
      scopes: chosen.join(","),
      mapCount: chosen.length ? capped : "",
    });
  }

  function toggle(id: WeatherMapId) {
    const has = selected.includes(id);
    const maps = WEATHER_MAPS.map((map) => map.id).filter((mapId) =>
      mapId === id ? !has : selected.includes(mapId),
    );
    write({ mapCount: Math.min(count, Math.max(1, maps.length)) }, maps);
  }

  return (
    <div>
      <div className="news-outlets" role="group" aria-label="Weather maps">
        {WEATHER_MAPS.map((map) => (
          <label className="news-outlet" key={map.id}>
            <input
              type="checkbox"
              checked={selected.includes(map.id)}
              disabled={disabled}
              onChange={() => toggle(map.id)}
            />
            <span>{map.label}</span>
          </label>
        ))}
      </div>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <div className="field">
          <label htmlFor="weather-map-count">Maps on screen</label>
          <input
            id="weather-map-count"
            type="number"
            min={1}
            max={Math.max(1, selected.length)}
            disabled={disabled || selected.length === 0}
            value={selected.length ? count : ""}
            onWheel={(event) => event.currentTarget.blur()}
            onChange={(event) => write({ mapCount: event.target.value })}
          />
        </div>
        <div className="field">
          <label className="rotate-optin" style={{ marginTop: 22 }}>
            <input
              type="checkbox"
              checked={rotate}
              disabled={disabled}
              onChange={(event) => write({ rotateMaps: event.target.checked })}
            />
            <span>Rotate these maps inside the weather panel</span>
          </label>
        </div>
      </div>
      {rotate ? (
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor="weather-map-seconds">Rotate every (seconds)</label>
          <div className="rotate-interval-row">
            {ROTATE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`btn${seconds === preset ? " active" : ""}`}
                disabled={disabled}
                onClick={() => write({ mapRotateSec: preset, rotateMaps: true })}
              >
                {preset >= 60 ? `${preset / 60}m` : `${preset}s`}
              </button>
            ))}
            <input
              id="weather-map-seconds"
              type="number"
              min={5}
              max={3600}
              disabled={disabled}
              value={seconds}
              onChange={(event) => write({ mapRotateSec: event.target.value, rotateMaps: true })}
            />
          </div>
        </div>
      ) : null}
      {help ? <div className="help">{help}</div> : null}
    </div>
  );
}
