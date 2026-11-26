# Shared tree-sitter code-highlighting wiring for both podspecs
# (EnrichedMarkdownCore in the monorepo, ReactNativeEnrichedMarkdown when
# published without the core pod). Podspecs are imperative Ruby that own their
# own source_files/defines/header paths, so unlike Android there is no build
# ownership problem: this computes exactly what to add.
#
# Only lib.c (the runtime) and each selected grammar's parser.c/scanner.c are
# compiled; every other vendored .c/.h is include-only and resolves through
# quoted relative includes, so the shared HEADER_SEARCH_PATHS never carries a
# grammar dir or tree-sitter/src (which would collide grammar parser.h files).
#
# The default grammar set is NOT hardcoded here: it is derived from the single
# source of truth, vendor/grammar-versions.json (every grammar with default:true),
# so the compiled sources always match the registry that gen-registry generates
# from the same manifest. The Android build derives it the same way.

require 'json'

module EnrichedMarkdownConfig
  @warnings_emitted = {}

  def self.warn_once(key, message)
    return if @warnings_emitted[key]
    @warnings_emitted[key] = true
    Pod::UI.warn message
  end

  # The consumer app's package.json "enriched-markdown" block is the build-time
  # source of truth for feature toggles (mirrors the Android build.gradle and
  # react-native-worklets). It is read from the Podfile's installation root --
  # "<app>/package.json", one level above the "<app>/ios" dir CocoaPods installs
  # into -- so in a monorepo it resolves to the app being built, not the workspace
  # root. Per-app config therefore works; the download side (postinstall) is a
  # separate, install-time decision. ENV vars remain a deprecated fallback.
  #
  # A cheap accessor over the memoized package.json (see consumer_package_json), so both
  # this file (code highlighting) and the main podspec (math) can read it without re-parsing.
  def self.consumer_config
    config = consumer_package_json['enriched-markdown']
    config.is_a?(Hash) ? config : {}
  end

  # A filesystem-safe identifier for the app being built, derived from its package.json
  # "name" (falling back to the app directory name). It keys the per-app generated
  # code-highlight registry (generated-<slug>) so that, in a hoisted monorepo, two apps
  # with different custom language sets each get their own registry instead of clobbering
  # a single shared one.
  def self.consumer_app_slug
    name = consumer_package_json['name'].to_s
    name = File.basename(File.dirname(Pod::Config.instance.installation_root.to_s)) if name.empty?
    slug = name.gsub(%r{[^A-Za-z0-9._-]+}, '-').gsub(/\A-+|-+\z/, '')
    slug.empty? ? 'app' : slug
  end

  def self.consumer_package_json
    return @consumer_package_json if defined?(@consumer_package_json)
    @consumer_package_json = load_consumer_package_json
  end

  def self.load_consumer_package_json
    path = File.join(Pod::Config.instance.installation_root.to_s, '..', 'package.json')
    return {} unless File.exist?(path)
    JSON.parse(File.read(path))
  rescue StandardError => e
    Pod::UI.warn "[ReactNativeEnrichedMarkdown] could not read the app package.json " \
      "(#{e.message}); using defaults."
    {}
  end
end

module EnrichedMarkdownCodeHighlight
  # Locate grammar-versions.json in both layouts, mirroring how gen-registry.mjs
  # is resolved below: "<podspec_dir>/../../vendor" in the monorepo, and the copy
  # dropped into "<podspec_dir>/cpp/highlight" by prepare-npm-publish.sh when
  # published.
  def self.manifest_path(podspec_dir)
    [
      File.join(podspec_dir, '../../vendor/grammar-versions.json'),
      File.join(podspec_dir, 'cpp/highlight/grammar-versions.json'),
    ].find { |p| File.exist?(p) }
  end

  # The default language set: every grammar flagged default:true in the manifest.
  def self.default_languages(podspec_dir)
    manifest = manifest_path(podspec_dir)
    raise '[code-highlight] grammar-versions.json not found; cannot resolve the ' \
          'default language set. Build from the monorepo or a published tarball.' unless manifest
    grammars = JSON.parse(File.read(manifest))['grammars'] || {}
    grammars.select { |_id, spec| spec['default'] }.keys
  end

  # podspec_dir is the directory of the including podspec; cpp is reached at
  # "<podspec_dir>/cpp" (a symlink in the monorepo, real files when published).
  def self.config(podspec_dir)
    config = EnrichedMarkdownConfig.consumer_config
    env_enable = ENV['ENRICHED_MARKDOWN_ENABLE_CODE_HIGHLIGHT']

    # Enable flag: package.json > ENV (deprecated) > default on. `explicit` tracks
    # whether the consumer actively opted in (vs the implicit default), which decides
    # the missing-asset behavior below.
    if config.key?('enableCodeHighlight')
      requested = config['enableCodeHighlight'] != false
      explicit = requested
      if env_enable
        EnrichedMarkdownConfig.warn_once(:code_highlight_env, '[ReactNativeEnrichedMarkdown] DEPRECATED: ENV[\'ENRICHED_MARKDOWN_ENABLE_CODE_HIGHLIGHT\'] ' \
          'is ignored when "enriched-markdown".enableCodeHighlight is set in your package.json.')
      end
    elsif env_enable
      EnrichedMarkdownConfig.warn_once(:code_highlight_env, '[ReactNativeEnrichedMarkdown] DEPRECATED: ENV[\'ENRICHED_MARKDOWN_ENABLE_CODE_HIGHLIGHT\'] ' \
        'will be removed in a future version. Configure via "enriched-markdown".enableCodeHighlight in your package.json instead.')
      requested = env_enable != '0'
      explicit = requested
    else
      requested = true
      explicit = false
    end

    return disabled unless requested

    # The grammars/.stamp marker is written only after every grammar source is fully
    # vendored at postinstall. If the consumer explicitly enabled highlighting but the
    # grammars are absent (opted out of the download, or a partial/failed one), fail
    # loud with the fix. If highlighting is merely on by default, degrade to the no-op
    # stub so a missing download never breaks an otherwise-unconfigured build.
    unless File.exist?(File.join(podspec_dir, 'cpp/highlight/vendor/grammars/.stamp'))
      if explicit
        raise '[ReactNativeEnrichedMarkdown] code highlighting is enabled but the tree-sitter ' \
          'grammars are not installed. Reinstall to fetch them: `npm rebuild react-native-enriched-markdown`. ' \
          'To disable, set "enriched-markdown".enableCodeHighlight = false in your app package.json. ' \
          'Troubleshooting: https://github.com/software-mansion/enriched-markdown/blob/main/docs-md/NATIVE_ASSETS.md'
      end
      return disabled
    end

    defaults = default_languages(podspec_dir)
    # Languages: package.json > ENV (deprecated) > manifest defaults. An explicit empty
    # array disables all languages (return disabled below); only the default/ENV paths
    # fall back to the manifest set.
    if config['codeHighlightLanguages'].is_a?(Array)
      langs = config['codeHighlightLanguages'].map { |l| l.to_s.strip }.reject(&:empty?)
    elsif (env_langs = ENV['ENRICHED_MARKDOWN_CODE_HIGHLIGHT_LANGUAGES']) && !env_langs.empty?
      EnrichedMarkdownConfig.warn_once(:code_highlight_languages_env, '[ReactNativeEnrichedMarkdown] DEPRECATED: ENV[\'ENRICHED_MARKDOWN_CODE_HIGHLIGHT_LANGUAGES\'] ' \
        'will be removed in a future version. Configure via "enriched-markdown".codeHighlightLanguages in your package.json instead.')
      langs = env_langs.split(',').map(&:strip).reject(&:empty?)
      langs = defaults.dup if langs.empty?
    else
      langs = defaults.dup
    end
    return disabled if langs.empty?

    vendor = File.join(podspec_dir, 'cpp/highlight/vendor')
    # A custom language set regenerates its registry into a per-app dir
    # (generated-<app-slug>), never the committed default-set registry in vendor/generated.
    # Keying by app (not by "generated-custom") means two apps in a hoisted monorepo with
    # different custom sets each get their own registry instead of clobbering a single
    # shared one -- which would leave the other app linking a mismatched grammar list.
    custom = langs.sort != defaults.sort
    generated_rel = custom ? "cpp/highlight/vendor/generated-#{EnrichedMarkdownConfig.consumer_app_slug}" : 'cpp/highlight/vendor/generated'
    generated = File.join(podspec_dir, generated_rel)
    ensure_registry(podspec_dir, vendor, generated, langs, custom)

    sources = [
      'cpp/highlight/vendor/tree-sitter/src/lib.c',
      "#{generated_rel}/generated_registry.cpp",
    ]
    langs.each do |lang|
      sources << "cpp/highlight/vendor/grammars/#{lang}/parser.c"
      if File.exist?(File.join(vendor, "grammars/#{lang}/scanner.c"))
        sources << "cpp/highlight/vendor/grammars/#{lang}/scanner.c"
      end
    end

    {
      enabled: true,
      source_files: sources,
      defines: ' ENRICHED_MARKDOWN_CODE_HIGHLIGHT=1',
      header_paths: [
        'cpp/highlight/vendor/tree-sitter/include',
        generated_rel,
      ],
    }
  end

  def self.disabled
    { enabled: false, source_files: [], defines: '', header_paths: [] }
  end

  # The committed default-set registry ships in-tree, so the default case needs no
  # codegen. A custom set (or a missing default registry) regenerates into `generated`
  # from the vendored .scm files.
  def self.ensure_registry(podspec_dir, vendor, generated, langs, custom)
    return if !custom && File.exist?(File.join(generated, 'generated_registry.cpp'))

    script = [
      File.join(podspec_dir, '../../vendor/gen-registry.mjs'),
      File.join(podspec_dir, 'cpp/highlight/gen-registry.mjs'),
    ].find { |p| File.exist?(p) }
    raise '[code-highlight] ENRICHED_MARKDOWN_CODE_HIGHLIGHT_LANGUAGES is customized but ' \
          'vendor/gen-registry.mjs was not found. Use the default set or build from the monorepo.' unless script

    # Canonicalize before handing the path to node: in the monorepo the package is
    # a workspace symlink, so the "../.." above resolves correctly for File.exist?
    # (which follows the symlink physically) but node would normalize ".." lexically
    # from the symlink location and miss the file. Android already does this via
    # File#canonicalPath.
    script = File.realpath(script)

    ok = system('node', script, '--vendor-dir', vendor, '--languages', langs.join(','), '--out', generated)
    raise '[code-highlight] gen-registry.mjs failed' unless ok
  end
end
