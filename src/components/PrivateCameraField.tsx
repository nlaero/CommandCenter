import { brandById, brandId, PRIVATE_BRANDS, streamLinkError } from "../lib/privateCameras";
import { playbackNoteForUrl } from "../lib/publicCameras";

type Props = {
  params: Record<string, unknown>;
  disabled?: boolean;
  onChange: (params: Record<string, unknown>) => void;
};

export function PrivateCameraField({ params, disabled, onChange }: Props) {
  const brand = brandById(params.brand);
  const url = typeof params.url === "string" ? params.url : "";
  const problem = url.trim() ? streamLinkError(url) : null;

  function choose(id: string) {
    if (disabled || brandId(params.brand) === id) return;
    onChange({ ...params, brand: id });
  }

  return (
    <div className="camera-link">
      <div className="location-choices" role="radiogroup" aria-label="Camera brand or system">
        {PRIVATE_BRANDS.map((item) => {
          const selected = brand.id === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`location-choice${selected ? " is-selected" : ""}`}
              disabled={disabled}
              onClick={() => choose(item.id)}
            >
              <span className="location-choice-mark" aria-hidden="true" />
              <span>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
      <ol className="camera-steps">
        {brand.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <label className="camera-url-label" htmlFor="camera-private-url">
        Stream link
      </label>
      <input
        id="camera-private-url"
        type="text"
        value={url}
        placeholder={brand.placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange({ ...params, url: event.target.value, brand: brand.id })}
      />
      {problem ? <p className="camera-picker-note">{problem}</p> : null}
      {url.trim() && !problem ? <p className="camera-picker-note">{playbackNoteForUrl(url.trim())}</p> : null}
    </div>
  );
}
