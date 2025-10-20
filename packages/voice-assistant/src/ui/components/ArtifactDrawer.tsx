import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { X } from "lucide-react";
import "./ArtifactDrawer.css";

export type Artifact = {
  type: "markdown" | "diff" | "image" | "code";
  id: string;
  title: string;
  content: string;
  isBase64: boolean;
};

interface ArtifactDrawerProps {
  artifact: Artifact | null;
  onClose: () => void;
}

export function ArtifactDrawer({ artifact, onClose }: ArtifactDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (artifact) {
      // Prevent body scroll when drawer is open
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [artifact]);

  if (!artifact) {
    return null;
  }

  return (
    <div className="artifact-drawer-overlay" onClick={onClose}>
      <div ref={drawerRef} className="artifact-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="artifact-drawer-header">
          <h2 className="artifact-drawer-title">
            {artifact.title}
          </h2>
          <div className="artifact-drawer-header-right">
            <div className="artifact-drawer-type-badge">
              {artifact.type}
            </div>
            <button
              className="artifact-drawer-close-button"
              onClick={onClose}
              type="button"
              title="Close"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="artifact-drawer-content">
          {artifact.type === "markdown" && (
            <div className="artifact-plan">
              <ReactMarkdown>
                {artifact.isBase64 ? atob(artifact.content) : artifact.content}
              </ReactMarkdown>
            </div>
          )}
          {artifact.type === "diff" && (
            <pre className="artifact-diff">
              <code>{artifact.isBase64 ? atob(artifact.content) : artifact.content}</code>
            </pre>
          )}
          {artifact.type === "code" && (
            <pre className="artifact-code">
              <code>{artifact.isBase64 ? atob(artifact.content) : artifact.content}</code>
            </pre>
          )}
          {artifact.type === "image" && (
            <div className="artifact-image">
              <img
                src={`data:image/png;base64,${artifact.content}`}
                alt={artifact.title}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
