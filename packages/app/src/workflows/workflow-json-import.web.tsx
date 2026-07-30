import { useCallback, useRef, type ChangeEvent, type ReactElement } from "react";
import { Upload } from "lucide-react-native";
import { Button } from "@/components/ui/button";

export function WorkflowJsonImport({
  onLoad,
}: {
  onLoad: (content: string) => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void file.text().then(onLoad);
    },
    [onLoad],
  );
  const handlePress = useCallback(() => inputRef.current?.click(), []);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        leftIcon={Upload}
        onPress={handlePress}
        testID="workflow-import-file"
      >
        Import file
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleChange}
        style={hiddenInputStyle}
      />
    </>
  );
}

const hiddenInputStyle = { display: "none" } as const;
