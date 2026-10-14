/* eslint-disable react/no-array-index-key -- Document sources are immutable; these positional rows never reorder. */
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { InteractiveSlider } from "./slider";
import { createContext, useContext, useCallback } from "react";
import { ScrollView, Text, View } from "react-native";
import { createLibrary, defineComponent } from "@openuidev/react-lang";
import {
  interactiveComponentSchemas,
  type InteractiveState,
} from "@getpaseo/protocol/interactive-response";
import { EditingTextInput } from "@/components/ui/text-input";
import { Button } from "@/components/ui/button";
import { MermaidFence } from "@/components/markdown/fence/mermaid";
import Svg, { Line, Polyline, Rect, Text as SvgText } from "react-native-svg";
import { styles } from "./styles";
import { HtmlArtifact } from "./html-artifact";

export const InteractiveFields = createContext<{
  state: InteractiveState;
  disabled: boolean;
  change: (name: string, value: string | number) => void;
}>({ state: {}, disabled: true, change: () => {} });
function SelectionOption({ name, option }: { name: string; option: string }) {
  const { state, change, disabled } = useContext(InteractiveFields);
  const select = useCallback(() => change(name, option), [change, name, option]);
  return (
    <Button
      size="sm"
      variant={state[name] === option ? "default" : "outline"}
      disabled={disabled}
      onPress={select}
    >
      {option}
    </Button>
  );
}
function Field({
  name,
  label,
  options,
  min,
  max,
}: {
  name: string;
  label: string;
  options?: string[];
  min?: number;
  max?: number;
}) {
  const { state, change, disabled } = useContext(InteractiveFields);
  const changeText = useCallback(
    (text: string) => {
      if (min === undefined) change(name, text);
      else {
        const number = Number(text);
        if (text && Number.isFinite(number) && number >= min && number <= Number(max))
          change(name, number);
      }
    },
    [change, name, min, max],
  );
  const value = state[name];
  if (min !== undefined && max !== undefined)
    return (
      <InteractiveSlider
        name={name}
        label={label}
        min={min}
        max={max}
        value={typeof value === "number" ? value : min}
        disabled={disabled}
        onChange={change}
      />
    );
  return (
    <View style={styles.content}>
      <Text style={styles.text}>{label}</Text>
      {options ? (
        <View style={styles.row}>
          {options.map((option) => (
            <SelectionOption key={option} name={name} option={option} />
          ))}
        </View>
      ) : (
        <EditingTextInput
          accessibilityLabel={label}
          editable={!disabled}
          style={styles.input}
          initialValue={value === undefined ? "" : String(value)}
          keyboardType={min === undefined ? "default" : "numeric"}
          onChangeText={changeText}
        />
      )}
    </View>
  );
}
function Chart({
  data,
  title,
  line,
  color,
  labelColor,
}: {
  data: { label: string; value: number }[];
  title: string;
  line: boolean;
  color: string;
  labelColor: string;
}) {
  const low = Math.min(0, ...data.map((p) => p.value));
  const high = Math.max(1, ...data.map((p) => p.value));
  const x = (i: number) => 35 + (i * 530) / Math.max(data.length, 1);
  const y = (value: number) => 180 - ((value - low) / (high - low)) * 155;
  return (
    <View>
      <Text style={styles.text}>{title}</Text>
      <Svg
        viewBox="0 0 600 225"
        width="100%"
        height={225}
        accessibilityLabel={`${title}: ${data.map((p) => `${p.label} ${p.value}`).join(", ")}`}
      >
        <Line x1={25} x2={580} y1={y(0)} y2={y(0)} stroke={labelColor} />
        {line ? (
          <Polyline
            points={data.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={3}
          />
        ) : (
          data.map((p, i) => (
            <Rect
              key={i}
              x={x(i)}
              y={Math.min(y(0), y(p.value))}
              width={Math.max(1, 400 / data.length)}
              height={Math.abs(y(p.value) - y(0))}
              fill={color}
            />
          ))
        )}
        {data.map((p, i) => (
          <SvgText key={i} x={x(i)} y={210} fontSize={10} fill={labelColor}>
            {p.label}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
}
const ThemedChart = withUnistyles(Chart);
const chartColors = (theme: Theme) => ({
  color: theme.colors.accent,
  labelColor: theme.colors.foregroundMuted,
});
const EMPTY_TEXT_STYLE = {};
export const library = createLibrary({
  root: "Layout",
  components: [
    defineComponent({
      name: "Text",
      description: "Text",
      props: interactiveComponentSchemas.Text,
      component: ({ props }) => <Text style={styles.text}>{props.content}</Text>,
    }),
    ...(["Layout", "Form"] as const).map((name) =>
      defineComponent({
        name,
        description: name,
        props: interactiveComponentSchemas[name],
        component: ({ props, renderNode }) => (
          <View style={styles.content}>
            {props.children.map((child, i) => (
              <View key={i}>{renderNode(child)}</View>
            ))}
          </View>
        ),
      }),
    ),
    defineComponent({
      name: "Comparison",
      description: "Comparison",
      props: interactiveComponentSchemas.Comparison,
      component: ({ props }) => (
        <ScrollView horizontal>
          <View>
            <View style={styles.row}>
              {props.columns.map((column, i) => (
                <Text key={i} style={styles.cell}>
                  {column}
                </Text>
              ))}
            </View>
            {props.rows.map((row, i) => (
              <View key={i} style={styles.row}>
                {row.map((cell, j) => (
                  <Text key={j} style={styles.cell}>
                    {cell}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      ),
    }),
    defineComponent({
      name: "Selection",
      description: "Selection",
      props: interactiveComponentSchemas.Selection,
      component: ({ props }) => <Field {...props} />,
    }),
    defineComponent({
      name: "Input",
      description: "Input",
      props: interactiveComponentSchemas.Input,
      component: ({ props }) => <Field {...props} />,
    }),
    defineComponent({
      name: "Slider",
      description: "Slider",
      props: interactiveComponentSchemas.Slider,
      component: ({ props }) => <Field {...props} />,
    }),
    ...(["BarChart", "LineChart"] as const).map((name) =>
      defineComponent({
        name,
        description: name,
        props: interactiveComponentSchemas[name],
        component: ({ props }) => (
          <ThemedChart {...props} line={name === "LineChart"} uniProps={chartColors} />
        ),
      }),
    ),
    defineComponent({
      name: "Mermaid",
      description: "Mermaid",
      props: interactiveComponentSchemas.Mermaid,
      component: ({ props }) => (
        <MermaidFence
          code={props.source}
          phase="complete"
          inheritedStyles={EMPTY_TEXT_STYLE}
          textStyle={EMPTY_TEXT_STYLE}
        />
      ),
    }),
    defineComponent({
      name: "HtmlArtifact",
      description: "HtmlArtifact",
      props: interactiveComponentSchemas.HtmlArtifact,
      component: ({ props }) => <HtmlArtifact html={props.html} />,
    }),
  ],
});
