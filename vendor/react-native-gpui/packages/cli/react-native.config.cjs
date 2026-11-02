module.exports = {
  commands: [
    {
      name: 'run-desktop',
      description:
        'Run the GPUI desktop target with Metro or as a release build',
      func: async (_argv, _config, options) => {
        const { runDesktop } = await import('./src/commands.js');
        await runDesktop({
          projectRoot: options.projectRoot,
          entryFile: options.entryFile,
          bundle: options.bundle,
          config: options.config,
          release: options.release,
          port: options.port,
          host: options.host,
          features: options.features,
          noLaunch: options.noLaunch === true || options.launch === false,
          packager: options.packager !== false && options.noPackager !== true,
          packagerLog: options.packagerLog === true,
          terminal: options.terminal,
        });
      },
      options: [
        { name: '--entry-file <path>', description: 'Application entry file' },
        {
          name: '--release',
          description: 'Bundle JavaScript and build the optimized app',
        },
        {
          name: '--port <number>',
          description: 'Metro server port (default: 8081)',
        },
        {
          name: '--host <host>',
          description: 'Metro server host (default: localhost)',
        },
        { name: '--config <path>', description: 'Metro configuration file' },
        { name: '--bundle <path>', description: 'Bundle output path' },
        {
          name: '--features <features>',
          description: 'Comma-separated Cargo features for the desktop app',
        },
        {
          name: '--no-launch',
          description: 'Build the desktop app without launching it',
        },
        {
          name: '--no-packager',
          description: 'Do not start Metro if it is not already running',
        },
        {
          name: '--terminal <app>',
          description:
            'Terminal app Metro opens in (default: $REACT_TERMINAL, then the platform default)',
        },
        {
          name: '--packager-log',
          description:
            'Run Metro in the background, logging to desktop/build/metro.log',
        },
      ],
      examples: [
        {
          desc: 'Run with Metro and Fast Refresh',
          cmd: 'npx react-native run-desktop',
        },
        {
          desc: 'Build a bundled release',
          cmd: 'npx react-native run-desktop --release',
        },
      ],
    },
    {
      name: 'package-desktop',
      description:
        'Build installable packages for this OS from desktop/desktop.json',
      func: async (_argv, _config, options) => {
        const { packageDesktop } = await import('./src/commands.js');
        await packageDesktop({
          projectRoot: options.projectRoot,
          targets: options.target,
          outDir: options.out,
        });
      },
      options: [
        {
          name: '--target <formats>',
          description:
            'Comma-separated formats: app, dmg, nsis, deb, appimage (default: all for this OS)',
        },
        {
          name: '--project-root <path>',
          description: 'React Native project directory',
        },
        { name: '--out <dir>', description: 'Output directory' },
      ],
      examples: [
        {
          desc: 'Build every format this OS can produce',
          cmd: 'npx react-native package-desktop',
        },
        {
          desc: 'Build only a dmg',
          cmd: 'npx react-native package-desktop --target dmg',
        },
      ],
    },
    {
      name: 'init-desktop',
      description: 'Add GPUI desktop support to an existing React Native app',
      func: async (_argv, _config, options) => {
        const { initDesktop } = await import('./src/commands.js');
        initDesktop({
          projectRoot: options.projectRoot,
          skipInstall: options.skipInstall,
        });
      },
      options: [
        {
          name: '--project-root <path>',
          description: 'React Native project directory',
        },
        {
          name: '--skip-install',
          description: 'Write the scaffold without installing packages',
        },
      ],
      examples: [
        {
          desc: 'Add desktop support to this app',
          cmd: 'npx react-native init-desktop',
        },
      ],
    },
    {
      name: 'create-library <name>',
      description: 'Create a GPUI TurboModule library in a new directory',
      func: async (argv, _config, options) => {
        const { createLibrary } = await import('./src/commands.js');
        createLibrary({
          libraryName: argv[0],
          type: options.type,
          destination: options.directory,
          moduleName: options.moduleName,
          packageName: options.packageName,
        });
      },
      options: [
        {
          name: '--type <rust|cpp>',
          description: 'Native implementation language (default: rust)',
        },
        { name: '--directory <path>', description: 'Output directory' },
        {
          name: '--module-name <name>',
          description: 'Native TurboModule name',
        },
        { name: '--package-name <name>', description: 'npm package name' },
      ],
      examples: [
        {
          desc: 'Create a Rust TurboModule package',
          cmd: 'npx react-native create-library AwesomeStorage',
        },
        {
          desc: 'Create a C++ TurboModule package',
          cmd: 'npx react-native create-library AwesomeStorage --type cpp',
        },
      ],
    },
    {
      name: 'collect-node-addons',
      description:
        'Copy the Node addons a bundle loads next to a packaged app executable',
      func: async (_argv, _config, options) => {
        const { collectNodeAddons } = await import('./src/commands.js');
        collectNodeAddons({
          bundle: options.bundle,
          out: options.out,
          platform: options.platform,
        });
      },
      options: [
        {
          name: '--bundle <path>',
          description: 'The bundle file to scan for _requireNodeLibrary calls',
        },
        {
          name: '--out <dir>',
          description: 'Directory to copy the addons into',
        },
        {
          name: '--platform <platform>',
          description:
            'Target platform for shared-library matching (default: the host)',
        },
      ],
      examples: [
        {
          desc: 'Collect the addons a release bundle loads',
          cmd: 'npx react-native collect-node-addons --bundle build/index.bundle --out build/node-addons',
        },
      ],
    },
  ],
};
