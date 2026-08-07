import type { ReactElement } from "react";
import { withUnistyles } from "react-native-unistyles";
import { SquareMinus, SquarePlus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";

const ThemedSquarePlus = withUnistyles(SquarePlus);
const ThemedSquareMinus = withUnistyles(SquareMinus);

const successMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const ICON_SIZE = 14;

/**
 * Whether a file was added or removed outright, shown beside its diff stat.
 *
 * Square-plus / square-minus because that is what every forge uses for the same fact, so it needs
 * no label — the shape is the word. It sits at the same muted weight as the "+12 −3" next to it:
 * these are footnotes on a file header, not the diff body where colour carries the line-by-line
 * signal.
 */
export function FileChangeIcon({ change }: { change: "added" | "deleted" }): ReactElement {
  const { t } = useTranslation();

  if (change === "added") {
    return (
      <ThemedSquarePlus
        size={ICON_SIZE}
        uniProps={successMapping}
        accessibilityLabel={t("workspace.git.diff.newFile")}
      />
    );
  }

  return (
    <ThemedSquareMinus
      size={ICON_SIZE}
      uniProps={dangerMapping}
      accessibilityLabel={t("workspace.git.diff.deletedFile")}
    />
  );
}
