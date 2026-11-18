import {
  confirmedNewsPlace,
  formatMiles,
  matchLocalOutlets,
  NATIONAL_OUTLETS,
  placeQuery,
  selectedNationalIds,
} from "../lib/news";

type Props = {
  params: Record<string, unknown>;
  disabled?: boolean;
  help?: string;
  onChange: (params: Record<string, unknown>) => void;
};

export function NewsOutletsField({ params, disabled, help, onChange }: Props) {
  const selected = selectedNationalIds(params);
  const place = confirmedNewsPlace(params);
  const local = place ? matchLocalOutlets(place.lat, place.lon) : [];
  const query = place ? placeQuery(place.label) : null;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({
      ...params,
      outlets: NATIONAL_OUTLETS.map((outlet) => outlet.id).filter((outletId) => next.has(outletId)),
    });
  }

  return (
    <div>
      <div className="news-outlets" role="group" aria-label="National outlets">
        {NATIONAL_OUTLETS.map((outlet) => (
          <label className="news-outlet" key={outlet.id}>
            <input
              type="checkbox"
              checked={selected.includes(outlet.id)}
              disabled={disabled}
              onChange={() => toggle(outlet.id)}
            />
            <span>{outlet.name}</span>
          </label>
        ))}
      </div>
      {help ? <div className="help">{help}</div> : null}
      <div className="news-local">
        <div className="section-label">Local</div>
        {!place ? (
          <p>Confirm the location above. Local outlets are filled in from that place.</p>
        ) : local.length ? (
          <ul>
            {local.map((outlet) => (
              <li key={outlet.id}>
                {outlet.name}
                <span className="news-miles">{formatMiles(outlet.distanceMi)}</span>
              </li>
            ))}
          </ul>
        ) : query ? (
          <p>
            No catalog outlet covers this place. Local headlines come from a Google News search for{" "}
            {query}.
          </p>
        ) : (
          <p>No catalog outlet covers this place, and the saved label does not name one.</p>
        )}
      </div>
    </div>
  );
}
