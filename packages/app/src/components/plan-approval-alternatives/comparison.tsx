import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PlanCard } from "@/components/plan-card";
import { MarkdownRenderer } from "@/components/markdown/renderer";

const PLAN = `## Simplifier la validation des plans

Conserver le contenu du plan et les actions disponibles, tout en clarifiant la décision à prendre.

### 1. Préserver le contexte
- Garder le plan complet et sa mise en forme Markdown.
- Conserver les dimensions de la fenêtre.

### 2. Organiser les actions
- Distinguer l’approbation, la revue et le transfert à un profil.
- Garder la copie du plan accessible.

### 3. Vérifier le résultat
- Contrôler la lisibilité et le défilement du contenu.
- Vérifier que toutes les actions restent accessibles.`;
const TITLE = "Plan";
const DESCRIPTION = "L’agent attend votre validation avant de poursuivre.";
const QUESTION = "Comment souhaitez-vous procéder ?";
const PROFILES = ["Développeur", "Relecteur"];
const VARIANTS = [
  ["Implémentation", "Composant réel de validation du plan, avec le gris chaud appliqué."],
  ["1 · Anthracite", "Bandeau gris foncé, contenu clair et actions neutres."],
  ["2 · Charbon", "Bandeau presque noir et bouton d’approbation assorti."],
  ["3 · Gris chaud", "Bandeau graphite, fond légèrement chaud et accent Paseo."],
  ["4 · Ardoise", "Bandeau gris froid, contenu gris clair et approbation ardoise."],
  ["5 · Fumé", "Bandeau gris moyen et zone de validation plus contrastée."],
];
const PALETTES = [
  {
    header: {},
    body: {},
    footer: {},
    border: {},
    title: {},
    subtitle: {},
    button: {},
    buttonText: {},
  },
  {
    header: { backgroundColor: "#343436" },
    body: { backgroundColor: "#fafafa" },
    footer: { backgroundColor: "#f4f4f5" },
    border: { borderColor: "#d4d4d8" },
    title: { color: "#fafafa" },
    subtitle: { color: "#d4d4d8" },
    button: {},
    buttonText: {},
  },
  {
    header: { backgroundColor: "#242426" },
    body: { backgroundColor: "#fafafa" },
    footer: { backgroundColor: "#eaeaed" },
    border: { borderColor: "#d4d4d8" },
    title: { color: "#fafafa" },
    subtitle: { color: "#d4d4d8" },
    button: { backgroundColor: "#343436" },
    buttonText: { color: "#fafafa" },
  },
  {
    header: { backgroundColor: "#403d3b" },
    body: { backgroundColor: "#faf8f5" },
    footer: { backgroundColor: "#efebe7" },
    border: { borderColor: "#ded8d2" },
    title: { color: "#faf8f5" },
    subtitle: { color: "#d8d0c9" },
    button: {},
    buttonText: {},
  },
  {
    header: { backgroundColor: "#374151" },
    body: { backgroundColor: "#f8fafc" },
    footer: { backgroundColor: "#e8edf2" },
    border: { borderColor: "#cbd5e1" },
    title: { color: "#f8fafc" },
    subtitle: { color: "#cbd5e1" },
    button: { backgroundColor: "#374151" },
    buttonText: { color: "#f8fafc" },
  },
  {
    header: { backgroundColor: "#52525b" },
    body: { backgroundColor: "#fafafa" },
    footer: { backgroundColor: "#dedee3" },
    border: { borderColor: "#bcbcc5" },
    title: { color: "#ffffff" },
    subtitle: { color: "#e4e4e7" },
    button: { backgroundColor: "#52525b" },
    buttonText: { color: "#ffffff" },
  },
];

export default function Comparison() {
  const [active, setActive] = useState(0);
  const [feedback, setFeedback] = useState("");
  const act = useCallback((label: string) => setFeedback(`${label} — aperçu uniquement`), []);
  const approve = useCallback(() => act("Approuver"), [act]);
  const copy = useCallback(() => act("Copier"), [act]);
  const review = useCallback(() => act("Revue"), [act]);
  const profileHandlers = useMemo(() => PROFILES.map((name) => () => act(name)), [act]);
  const tabs = useMemo(
    () =>
      VARIANTS.map((_, index) => ({
        state: { selected: active === index },
        press: () => {
          setActive(index);
          setFeedback("");
        },
      })),
    [active],
  );
  const palette = PALETTES[active];
  const colored = useMemo(
    () => ({
      frame: [styles.frame, palette.body, palette.border],
      header: [styles.header, palette.header],
      title: [styles.title, palette.title],
      subtitle: [styles.muted, palette.subtitle],
      footer: [styles.decision, palette.footer, palette.border],
    }),
    [palette],
  );
  const approval = useMemo(
    () => (
      <Button
        size="sm"
        variant="default"
        onPress={approve}
        style={palette.button}
        textStyle={palette.buttonText}
      >
        Approuver
      </Button>
    ),
    [approve, palette],
  );
  const tools = useMemo(
    () => (
      <View style={styles.tools}>
        <Button size="sm" variant="outline" onPress={copy}>
          Copier
        </Button>
        <Button size="sm" variant="outline" onPress={review}>
          Revue
        </Button>
      </View>
    ),
    [copy, review],
  );
  const handoff = useMemo(
    () => (
      <View style={styles.profiles}>
        <Text style={styles.muted}>Handoff :</Text>
        {PROFILES.map((name, index) => (
          <Button key={name} size="sm" onPress={profileHandlers[index]}>
            {name}
          </Button>
        ))}
      </View>
    ),
    [profileHandlers],
  );
  const question = useMemo(() => <Text style={styles.question}>{QUESTION}</Text>, []);
  const actions = useMemo(
    () => (
      <View style={styles.actions}>
        {tools}
        {approval}
      </View>
    ),
    [tools, approval],
  );
  const implementedFooter = useMemo(
    () => (
      <View style={styles.implementedFooter}>
        {question}
        {actions}
        {handoff}
      </View>
    ),
    [question, actions, handoff],
  );
  const coloredContent = (
    <>
      {" "}
      <View style={colored.header}>
        <View style={styles.heading}>
          <Text style={colored.title}>{TITLE}</Text>
          <Text style={colored.subtitle}>{DESCRIPTION}</Text>
        </View>
      </View>
      <ScrollView key={active} style={styles.reading} contentContainerStyle={styles.readingContent}>
        <MarkdownRenderer text={PLAN} />
      </ScrollView>
      <View style={colored.footer}>
        {question}
        {actions}
        {handoff}
      </View>
    </>
  );
  const frame = (
    <View testID="plan-comparison-frame" style={colored.frame}>
      {active === 0 ? (
        <ScrollView contentContainerStyle={styles.implementedContent}>
          <PlanCard
            title={TITLE}
            description={DESCRIPTION}
            text={PLAN}
            outcome="pending"
            disableOuterSpacing
            footer={implementedFooter}
            testID="implemented-plan-card"
          />
        </ScrollView>
      ) : (
        coloredContent
      )}
    </View>
  );
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.intro}>
        <Text style={styles.title}>Validation du plan — alternatives</Text>
        <Text style={styles.muted}>
          Même disposition · même contenu · 760 × 560 px · variantes de couleurs
        </Text>
      </View>
      <View style={styles.tabs}>
        {VARIANTS.map(([label], index) => (
          <Button
            key={label}
            size="sm"
            variant={active === index ? "secondary" : "ghost"}
            accessibilityState={tabs[index].state}
            onPress={tabs[index].press}
          >
            {label}
          </Button>
        ))}
      </View>
      <Text style={styles.description}>{VARIANTS[active][1]}</Text>
      {frame}
      <Text accessibilityLiveRegion="polite" style={styles.feedback}>
        {feedback || "Les actions sont simulées et ne déclenchent aucun agent."}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flexGrow: 1,
    padding: theme.spacing[6],
    alignItems: "center",
    gap: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  intro: { width: "100%", maxWidth: 920, gap: 8 },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 4, width: "100%", maxWidth: 920 },
  description: {
    width: "100%",
    maxWidth: 920,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  frame: {
    width: 760,
    maxWidth: "100%",
    height: 560,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  header: { padding: 20, borderBottomWidth: 1, borderColor: theme.colors.border },
  heading: { gap: 4 },
  implementedContent: { padding: 16 },
  implementedFooter: { gap: 12 },
  reading: { flex: 1, minHeight: 0, minWidth: 0 },
  readingContent: { padding: 24 },
  question: { color: theme.colors.foreground, fontSize: theme.fontSize.base, lineHeight: 22 },
  tools: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  actions: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  profiles: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  decision: {
    padding: 20,
    gap: 12,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  feedback: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, minHeight: 20 },
}));
