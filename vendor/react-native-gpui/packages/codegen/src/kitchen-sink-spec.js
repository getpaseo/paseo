export const KITCHEN_SINK_SPEC = `import {
  codegenNativeCommands,
  codegenNativeComponent,
  type CodegenTypes,
  type ColorValue,
  type ImageSource,
  type ViewProps,
} from 'react-native';

export interface NativeProps extends ViewProps {
  lineWidth?: Int32;
  opacity?: Float;
  ratio?: Double;
  flag?: boolean;
  tickCount?: CodegenTypes.WithDefault<Int32, 7>;
  mode?: CodegenTypes.WithDefault<'line' | 'bar', 'line'>;
  title?: string;
  lineColor?: ColorValue;
  icon?: ImageSource;
  points?: ReadonlyArray<Readonly<{ x: Double; y: Double }>>;
  values?: ReadonlyArray<Double>;
  labels?: ReadonlyArray<string>;
  card?: Readonly<{
    title: string;
    nested: Readonly<{ flag: boolean; names: ReadonlyArray<string> }>;
  }>;
  cards?: ReadonlyArray<Readonly<{ title: string; count: Int32 }>>;
  extra?: CodegenTypes.UnsafeMixed;
  onPointSelected?: CodegenTypes.DirectEventHandler<
    Readonly<{ index: Int32; x: Double; label: string }>
  >;
  onRich?: CodegenTypes.DirectEventHandler<
    Readonly<{ nested: Readonly<{ flag: boolean; names: string[] }> }>
  >;
  onDone?: CodegenTypes.DirectEventHandler<null>;
}

export interface FixtureChartCommands {
  selectPoint: (ref: React.ComponentRef<typeof FixtureChart>, index: Int32) => void;
  reportSeries: (
    ref: React.ComponentRef<typeof FixtureChart>,
    values: Array<Double>,
  ) => void;
  setTitle: (ref: React.ComponentRef<typeof FixtureChart>, title: string) => void;
}

export const Commands = codegenNativeCommands<FixtureChartCommands>({
  supportedCommands: ['selectPoint', 'reportSeries', 'setTitle'],
});

const FixtureChart: any = null;

export default codegenNativeComponent<NativeProps>('FixtureChart', {
  interfaceOnly: true,
});
`;
