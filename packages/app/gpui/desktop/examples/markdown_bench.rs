use gpui::{
    div, px, App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window,
    WindowBounds, WindowOptions,
};
use react_native_gpui::DesktopAppConfig;
use rn_gpui_enriched_markdown::layout::{layout_document, LaidOutDocument};
use rn_gpui_enriched_markdown::model::MarkdownSnapshot;
use rn_gpui_enriched_markdown::render::render_document;
use std::ffi::{c_char, c_int, CStr, CString};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

extern "C" {
    fn rn_gpui_markdown_bench_stages(
        markdown: *const c_char,
        is_gfm: bool,
        style_json: *const c_char,
        out_parse_ns: *mut f64,
        out_highlight_ns: *mut f64,
        out_serialize_ns: *mut f64,
        out_json: *mut *mut c_char,
        out_json_len: *mut usize,
    ) -> c_int;
    fn rn_gpui_markdown_bench_free(ptr: *mut c_char);
}

struct BenchState {
    render_doc_ns: f64,
}

struct BenchView {
    doc: Arc<LaidOutDocument>,
    state: Arc<Mutex<BenchState>>,
}

impl Render for BenchView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let t0 = Instant::now();
        let el = render_document(&self.doc, 1);
        let elapsed_ns = t0.elapsed().as_secs_f64() * 1e9;
        if let Ok(mut s) = self.state.lock() {
            s.render_doc_ns = elapsed_ns;
        }
        div().w(px(720.0)).bg(gpui::rgb(0xffffff)).child(el)
    }
}

const STYLE_JSON: &str = r##"{
  "paragraph": { "fontSize": 15, "lineHeight": 21, "color": 4279900702, "marginBottom": 12 },
  "h1": { "fontSize": 24, "lineHeight": 31, "fontWeight": "bold", "color": 4279900702, "marginBottom": 12 },
  "h2": { "fontSize": 21, "lineHeight": 27, "fontWeight": "bold", "color": 4279900702, "marginBottom": 12 },
  "h3": { "fontSize": 18, "lineHeight": 23, "fontWeight": "bold", "color": 4279900702, "marginBottom": 12 },
  "list": { "fontSize": 15, "lineHeight": 21, "color": 4279900702, "bulletColor": 4285624698, "markerColor": 4285624698, "gapWidth": 7, "itemSpacing": 4, "marginLeft": 20, "marginBottom": 12 },
  "blockquote": { "fontSize": 15, "lineHeight": 21, "color": 4279900702, "backgroundColor": 4294638330, "borderColor": 4293190887, "borderWidth": 3, "padding": 12, "gapWidth": 8, "marginBottom": 12 },
  "link": { "color": 4280523094, "underline": false },
  "code": { "fontFamily": "monospace", "fontScale": 0.8, "color": 4279900702, "backgroundColor": 4294243573 },
  "codeBlock": {
    "fontFamily": "monospace", "fontSize": 12, "lineHeight": 21, "color": 4279900702,
    "backgroundColor": 4294243573, "borderColor": 4293190887, "borderRadius": 8, "padding": 12, "marginBottom": 12,
    "syntaxColors": {
      "keyword": 4294933362, "string": 4289058559, "comment": 4287337630, "number": 4286169343,
      "type": 4294944343, "function": 4291995903, "operatorColor": 4294933362, "punctuation": 4286495103
    }
  },
  "table": {
    "fontSize": 15, "lineHeight": 21, "color": 4279900702,
    "headerBackgroundColor": 4294243573, "headerTextColor": 4279900702,
    "rowEvenBackgroundColor": 4294967295, "rowOddBackgroundColor": 4294638330,
    "borderColor": 4293190887, "marginBottom": 12
  }
}"##;

fn build_realistic_reply(target_bytes: usize) -> String {
    let section_prose = "\n## Module Analysis and Data Flow\n\n\
The renderer translates snapshots from `packages/react-native-enriched-markdown/cpp/GpuiMarkdownBridge.cpp` into \
**GPUI elements** with *inline styles* and links such as [protocol docs](https://paseo.sh/docs/protocol). \
When a streaming token arrives, React commits the updated `markdown` string and re-measures the node.\n\n\
- Preserves AST structure for headings, paragraphs, emphasis, and `inline_code`\n\
- Highlights fenced code blocks using Tree-sitter grammars\n\
- Lays out GFM tables with measured column widths\n";

    let section_code = "\n```ts\n\
export interface StreamDelta {\n\
  readonly messageId: string;\n\
  readonly seq: number;\n\
  readonly chunk: string;\n\
}\n\n\
export function applyDelta(acc: Map<string, string>, delta: StreamDelta): string {\n\
  const prev = acc.get(delta.messageId) ?? \"\";\n\
  const next = prev + delta.chunk;\n\
  acc.set(delta.messageId, next);\n\
  return next;\n\
}\n\
```\n";

    let section_table = "\n| Stage | Input | Output | Owner |\n\
| --- | --- | --- | --- |\n\
| Parse | Markdown UTF-8 | MD4C AST | C++ |\n\
| Highlight | Code lines | Token ranges | Tree-sitter |\n\
| Serialize | AST + Style | JSON string | folly::toJson |\n\
| Deserialize | JSON string | MarkdownSnapshot | serde_json |\n\
| Layout | Snapshot + width | LaidOutDocument | layout.rs |\n\
| Paint | LaidOutDocument | GPUI scene | render.rs + gpui |\n";

    let mut out = String::from("# Architecture Overview\n\nStreaming reply benchmark fixture with realistic prose, code blocks, lists, and a table.\n");
    out.push_str(section_table);
    let mut i = 0usize;
    while out.len() < target_bytes {
        out.push_str(section_prose);
        if i % 2 == 0 {
            out.push_str(section_code);
        }
        if i % 5 == 4 && out.len() + section_table.len() < target_bytes {
            out.push_str(section_table);
        }
        i += 1;
    }
    out
}

fn median_ms(samples: &mut [f64]) -> f64 {
    samples.sort_by(|a, b| a.total_cmp(b));
    let mid = samples.len() / 2;
    if samples.len() % 2 == 0 {
        ((samples[mid - 1] + samples[mid]) * 0.5) / 1e6
    } else {
        samples[mid] / 1e6
    }
}

fn mean_ms(samples: &[f64]) -> f64 {
    let sum: f64 = samples.iter().sum();
    (sum / samples.len() as f64) / 1e6
}

fn run_bench_on_app(cx: &mut App) {
    let bench_state = Arc::new(Mutex::new(BenchState { render_doc_ns: 0.0 }));
    let bench_state_init = bench_state.clone();
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(gpui::Bounds::centered(
                    None,
                    gpui::size(px(800.0), px(1200.0)),
                    cx,
                ))),
                ..Default::default()
            },
            |_, cx| {
                cx.new(|_| BenchView {
                    doc: Arc::new(LaidOutDocument::default()),
                    state: bench_state_init,
                })
            },
        )
        .unwrap();
    let _ = cx.update_window(window.into(), |_, window, cx| {
        window.draw(cx).clear(cx);
    });

    let style_c = CString::new(STYLE_JSON).unwrap();

    for &(label, target_bytes, iters) in &[
        ("5 KB", 5 * 1024usize, 25usize),
        ("20 KB", 20 * 1024usize, 15usize),
        ("100 KB", 100 * 1024usize, 7usize),
    ] {
        let base = build_realistic_reply(target_bytes);
        let actual_bytes = base.len();
        let mut parse_s = Vec::with_capacity(iters);
        let mut hl_s = Vec::with_capacity(iters);
        let mut ser_s = Vec::with_capacity(iters);
        let mut deser_s = Vec::with_capacity(iters);
        let mut layout_s = Vec::with_capacity(iters);
        let mut paint_s = Vec::with_capacity(iters);
        let mut build_el_s = Vec::with_capacity(iters);

        for step in 0..=iters {
            let md = if step == 0 {
                base.clone()
            } else {
                format!("{base}\nStreamed token chunk #{step}.")
            };
            let md_c = CString::new(md).unwrap();
            let mut parse_ns = 0.0f64;
            let mut hl_ns = 0.0f64;
            let mut ser_ns = 0.0f64;
            let mut out_ptr: *mut c_char = std::ptr::null_mut();
            let mut out_len: usize = 0;
            let rc = unsafe {
                rn_gpui_markdown_bench_stages(
                    md_c.as_ptr(),
                    true,
                    style_c.as_ptr(),
                    &mut parse_ns,
                    &mut hl_ns,
                    &mut ser_ns,
                    &mut out_ptr,
                    &mut out_len,
                )
            };
            assert_eq!(rc, 0, "C++ bench failed");
            let json = unsafe { CStr::from_ptr(out_ptr) }
                .to_str()
                .unwrap()
                .to_owned();
            unsafe { rn_gpui_markdown_bench_free(out_ptr) };

            let t_deser = Instant::now();
            let snapshot: MarkdownSnapshot = serde_json::from_str(&json).unwrap();
            let deser_ns = t_deser.elapsed().as_secs_f64() * 1e9;

            let t_layout = Instant::now();
            let doc = Arc::new(layout_document(&snapshot, Some(680.0)));
            let layout_ns = t_layout.elapsed().as_secs_f64() * 1e9;

            let mut paint_elapsed = Duration::ZERO;
            let _ = window.update(cx, |v, _, cx| {
                v.doc = doc.clone();
                cx.notify();
            });
            let _ = cx.update_window(window.into(), |_, window, cx| {
                let t_paint = Instant::now();
                window.refresh();
                window.draw(cx).clear(cx);
                paint_elapsed = t_paint.elapsed();
            });
            let render_doc_ns = bench_state.lock().map(|s| s.render_doc_ns).unwrap_or(0.0);

            if step > 0 {
                parse_s.push(parse_ns);
                hl_s.push(hl_ns);
                ser_s.push(ser_ns);
                deser_s.push(deser_ns);
                layout_s.push(layout_ns);
                paint_s.push(paint_elapsed.as_secs_f64() * 1e9);
                build_el_s.push(render_doc_ns);
            }
        }

        let p_med = median_ms(&mut parse_s);
        let h_med = median_ms(&mut hl_s);
        let s_med = median_ms(&mut ser_s);
        let d_med = median_ms(&mut deser_s);
        let l_med = median_ms(&mut layout_s);
        let pt_med = median_ms(&mut paint_s);
        let total_med = p_med + h_med + s_med + d_med + l_med + pt_med;
        println!(
            "SIZE={label} bytes={actual_bytes} iters={iters} | MEDIAN_MS: parse={p_med:.3} highlight={h_med:.3} serialize={s_med:.3} deserialize={d_med:.3} layout={l_med:.3} paint={pt_med:.3} (build_el={:.3}) total={total_med:.3} | MEAN_MS: parse={:.3} highlight={:.3} serialize={:.3} deserialize={:.3} layout={:.3} paint={:.3}",
            median_ms(&mut build_el_s),
            mean_ms(&parse_s),
            mean_ms(&hl_s),
            mean_ms(&ser_s),
            mean_ms(&deser_s),
            mean_ms(&layout_s),
            mean_ms(&paint_s),
        );
    }
    std::process::exit(0);
}

fn main() {
    rn_gpui_autolink::ensure_linked();
    let config =
        DesktopAppConfig::from_env_with_defaults(env!("RN_GPUI_APP_NAME"), env!("RN_GPUI_APP_ID"))
            .window_title("Markdown Bench")
            .window_size(800.0, 1200.0)
            .on_app_ready(run_bench_on_app);

    react_native_gpui::run_with(config);
}
