import { useEffect, useMemo, useRef, useState } from "react";
import { parseOmpFormMessage } from "./omp-form-document";
import type { OmpFormFrameProps } from "./omp-form-frame";

export function OmpFormFrame({ document, title, onAnswer }: OmpFormFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const style = useMemo(() => ({ width: "100%", height, border: 0, display: "block" }), [height]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const message = parseOmpFormMessage(event.data);
      if (!message) return;
      if ("height" in message) setHeight(message.height);
      else onAnswer(message);
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onAnswer]);

  return (
    <iframe
      ref={frame}
      title={title}
      srcDoc={document}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      style={style}
    />
  );
}
