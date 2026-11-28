require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

monorepo = File.exist?(File.expand_path("../core/EnrichedMarkdownCore.podspec", __dir__))
cpp_root = monorepo ? "$(PODS_TARGET_SRCROOT)/../core/cpp" : "$(PODS_TARGET_SRCROOT)/cpp"

require File.join(__dir__, "cpp/highlight/code_highlight_podspec.rb")
# In the monorepo the C++ (including tree-sitter highlighting) compiles in the
# EnrichedMarkdownCore pod; only the published, core-less build compiles it here.
code_highlight = monorepo ? EnrichedMarkdownCodeHighlight.disabled : EnrichedMarkdownCodeHighlight.config(__dir__)

Pod::Spec.new do |s|
  s.name         = "ReactNativeEnrichedMarkdown"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported, :osx => '14.0' }
  s.source       = { :git => "https://github.com/software-mansion/enriched-markdown.git", :tag => "#{s.version}" }

  if monorepo
    s.private_header_files = "ios/**/*.h"
    s.source_files = "ios/**/*.{h,m,mm,cpp,swift}"
    s.dependency "EnrichedMarkdownCore"
  else
    s.private_header_files = "ios/**/*.h", "cpp/**/*.{h,hpp}"
    s.source_files = ["ios/**/*.{h,m,mm,cpp,swift}", "cpp/md4c/*.{c,h}", "cpp/parser/*.{hpp,cpp}", "cpp/highlight/*.{hpp,cpp}"] + code_highlight[:source_files]
    s.preserve_paths = "cpp/highlight/vendor/**/*" if code_highlight[:enabled]
  end

  # LaTeX math rendering (RaTeX, iOS only). RaTeX ships as a prebuilt static XCFramework
  # vendored under ios/vendor (restored by vendor/vendor-ratex.mjs at postinstall); it
  # links under CocoaPods default static linkage and needs neither `use_frameworks!` nor
  # SPM interop.
  #
  # The app package.json "enriched-markdown" block is the source of truth; ENV is a
  # deprecated fallback. `math_explicit` tracks an active opt-in (vs the implicit
  # default), which decides the missing-framework behavior below.
  config = EnrichedMarkdownConfig.consumer_config
  # "present" mirrors the code-highlight side (see code_highlight_podspec.rb, which
  # gates on grammars/.stamp): the vendor script writes ios/vendor/.stamp only after
  # the XCFramework, the four Swift sources, and the fonts have all landed and it
  # swaps the tree into place atomically. Gating on the XCFramework directory alone
  # would treat a half-finished download (framework extracted, Swift sources/fonts
  # still missing) as ready and compile the RaTeX bridge against sources that are not
  # there, failing several hundred lines into the pod build with an opaque Swift
  # "cannot find type 'RaTeXRenderer' in scope" (#745).
  ratex_dir = File.join(__dir__, 'ios/vendor')
  # File.file? (not File.exist?) so a stray .stamp/ directory can't pass the check and
  # reintroduce the #745 failure mode; the vendor script only ever writes it as a file.
  ratex_present = File.directory?(File.join(ratex_dir, 'RaTeX.xcframework')) &&
    File.file?(File.join(ratex_dir, '.stamp'))
  math_flag = ENV['ENRICHED_MARKDOWN_ENABLE_MATH']

  if config.key?('enableMath')
    math_requested = config['enableMath'] != false
    math_explicit = math_requested
    if math_flag
      EnrichedMarkdownConfig.warn_once(:math_env, '[ReactNativeEnrichedMarkdown] DEPRECATED: ENV[\'ENRICHED_MARKDOWN_ENABLE_MATH\'] ' \
        'is ignored when "enriched-markdown".enableMath is set in your package.json.')
    end
  elsif math_flag
    EnrichedMarkdownConfig.warn_once(:math_env, '[ReactNativeEnrichedMarkdown] DEPRECATED: ENV[\'ENRICHED_MARKDOWN_ENABLE_MATH\'] ' \
      'will be removed in a future version. Configure via "enriched-markdown".enableMath in your package.json instead.')
    math_requested = math_flag == '1'
    math_explicit = math_requested
  else
    math_requested = true
    math_explicit = false
  end

  # RaTeX is downloaded at postinstall and kept out of the tarball. Reconcile the
  # request with the vendored tree: an explicit opt-in with the tree missing or
  # incomplete fails loud; on by default but missing (a partial/failed download, or a
  # monorepo root opt-out) falls back to a clean build without math.
  enable_math = math_requested && ratex_present
  if !math_requested
    EnrichedMarkdownConfig.warn_once(:math_disabled, '[ReactNativeEnrichedMarkdown] LaTeX math disabled via ' \
      '"enriched-markdown".enableMath = false in your app package.json.')
  elsif !ratex_present
    if math_explicit
      raise '[ReactNativeEnrichedMarkdown] LaTeX math is enabled but the vendored RaTeX ' \
        'assets are missing or incomplete at ios/vendor (need RaTeX.xcframework, the core ' \
        'Swift sources, the fonts, and the .stamp the vendor script writes on success). ' \
        'Reinstall to fetch them: `npm rebuild react-native-enriched-markdown`. ' \
        'To disable math, set "enriched-markdown".enableMath = false in your app package.json. ' \
        'Troubleshooting: https://github.com/software-mansion/enriched-markdown/blob/main/docs-md/NATIVE_ASSETS.md'
    end
    EnrichedMarkdownConfig.warn_once(:math_disabled, '[ReactNativeEnrichedMarkdown] LaTeX math disabled: the vendored RaTeX ' \
      'assets were not found or are incomplete at ios/vendor. If this is unintended, re-run ' \
      '`node node_modules/react-native-enriched-markdown/postinstall.mjs`.')
  end

  # The RaTeX XCFramework bundles its own module.modulemap and headers; never let the
  # broad ios/**/*.h and ios/**/*.swift globs treat its internals as pod sources.
  exclude = ["ios/vendor/RaTeX.xcframework/**/*"]
  # ios/math holds the RaTeX bridge; ios/vendor/*.swift are RaTeX's vendored core Swift
  # sources. Both compile into this pod's module only when math is enabled.
  exclude += ["ios/math/**/*.swift", "ios/vendor/*.swift"] unless enable_math
  s.exclude_files = exclude
  # Bounded decoding of native pill icons.
  s.frameworks = "ImageIO"

  # Video playback (AVKit, built into iOS — no external framework or vendored asset).
  # Default on: consumers opt out via "enriched-markdown".enableVideo = false in package.json.
  enable_video = config.key?('enableVideo') ? config['enableVideo'] != false : true

  preprocessor_defs = "$(inherited) MD4C_USE_UTF8=1#{code_highlight[:defines]}"
  if enable_video
    preprocessor_defs += ' ENRICHED_MARKDOWN_VIDEO=1'
  end
  if enable_math
    preprocessor_defs += ' ENRICHED_MARKDOWN_MATH=1'
    # enable_math already implies ratex_present, i.e. a complete vendored tree marked by
    # ios/vendor/.stamp (the reconciliation above raises on an explicit opt-in with a
    # missing/incomplete tree and disables the default-on path), so the vendored
    # references below always resolve.
    # Prebuilt static XCFramework (device + simulator[arm64,x86_64] + macOS). Vendored
    # rather than pulled via spm_dependency, which compiled RaTeX's Swift wrapper per
    # requested arch (breaking universal simulator builds, #527) and double-collected
    # its XCFramework signature during archive assembly (#491).
    s.vendored_frameworks = 'ios/vendor/RaTeX.xcframework'
    # RaTeXFontLoader.loadFromCocoaPodsBundle() resolves "RaTeXCoreFonts.bundle" by name,
    # so this resource-bundle name is load-bearing -- keep it exactly RaTeXCoreFonts.
    s.resource_bundles = { 'RaTeXCoreFonts' => ['ios/vendor/Fonts/*.ttf'] }
  end

  pod_xcconfig = {
    'HEADER_SEARCH_PATHS' => ([
      "\"#{cpp_root}/md4c\"", "\"#{cpp_root}/parser\"", "\"#{cpp_root}/highlight\"",
      "\"$(PODS_TARGET_SRCROOT)/ios/internals\"", "\"$(PODS_TARGET_SRCROOT)/ios/input/internals\""
    ] + code_highlight[:header_paths].map { |p| "\"$(PODS_TARGET_SRCROOT)/#{p}\"" }).join(" "),
    'GCC_PREPROCESSOR_DEFINITIONS' => preprocessor_defs,
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'DEFINES_MODULE' => 'YES'
  }

  # No EXCLUDED_ARCHS dance: the vendored simulator slice (ios-arm64_x86_64-simulator)
  # already contains x86_64, so universal simulator builds resolve on both arches.
  s.pod_target_xcconfig = pod_xcconfig

  # No script phases: vendoring a single prebuilt XCFramework means there is no
  # spm_dependency-generated duplicate RaTeXFFI modulemap to strip, and only one
  # signature is collected during archive assembly, so nothing collides.

  install_modules_dependencies(s)
end
