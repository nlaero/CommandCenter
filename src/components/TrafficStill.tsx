import { useEffect, useRef, useState } from "react";
import { fittedStillBox } from "../lib/fittedStill";

type Props = {
  src: string;
  alt?: string;
  onError?: () => void;
};

/** Picture sized to the panel it sits in, at the picture's own aspect. */
export function TrafficStill({ src, alt = "", onError }: Props) {
  const fitRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState({ width: 0, height: 0 });
  const [aspect, setAspect] = useState(4 / 3);

  useEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      setPanel((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const box = fittedStillBox(panel.width, panel.height, aspect);

  return (
    <div className="traffic-video-fit" ref={fitRef}>
      <img
        src={src}
        alt={alt}
        style={box.width > 0 ? { width: box.width, height: box.height } : undefined}
        onLoad={(event) => {
          const img = event.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            const next = img.naturalWidth / img.naturalHeight;
            setAspect((prev) => (Math.abs(prev - next) < 0.001 ? prev : next));
          }
        }}
        onError={onError}
      />
    </div>
  );
}
