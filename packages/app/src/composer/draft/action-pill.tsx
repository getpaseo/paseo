import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { composerPillStyles } from "@/composer/pill-styles";

interface ComposerDraftActionPillProps {
  testID: string;
  label: string;
  icon?: ReactElement | null;
  onPress: () => void;
  disabled?: boolean;
}

export function ComposerDraftActionPill({
  testID,
  label,
  icon,
  onPress,
  disabled = false,
}: ComposerDraftActionPillProps) {
  return (
    <Button
      variant="ghost"
      size="xs"
      testID={testID}
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={composerPillStyles.body}
      textStyle={composerPillStyles.label}
      leftIcon={icon}
    >
      {label}
    </Button>
  );
}
