#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const [reactNativeRoot, outputDir] = process.argv.slice(2);
if (!reactNativeRoot || !outputDir) {
  throw new Error(
    'usage: generate-fbreactnativespec.cjs <react-native-root> <output-dir>',
  );
}
const reactNativeDir = path.resolve(reactNativeRoot);

const packageRoot = path.resolve(__dirname, '../../..');
const platformPackage = require(path.join(packageRoot, 'package.json'));
const expectedVersion = platformPackage.peerDependencies['react-native'];
const reactNativePackage = require(path.join(reactNativeDir, 'package.json'));
if (reactNativePackage.version !== expectedVersion) {
  throw new Error(
    `React Native ${reactNativePackage.version} is installed; this generated GPUI spec is pinned to ${expectedVersion}. Update the pin and verify the generated C++ before continuing.`,
  );
}

const codegenUtils = require(
  path.join(reactNativeDir, 'scripts/codegen/codegen-utils.js'),
);
const executor = require(
  path.join(reactNativeDir, 'scripts/codegen/generate-specs-cli-executor.js'),
);
const schema = codegenUtils
  .getCombineJSToSchema()
  .combineSchemasInFileList([path.join(reactNativeDir, 'src')], 'android');

const generatedDir = path.resolve(outputDir);
fs.rmSync(generatedDir, { recursive: true, force: true });
fs.mkdirSync(generatedDir, { recursive: true });
executor.generateSpecFromInMemorySchema(
  'android',
  schema,
  generatedDir,
  'FBReactNativeSpec',
  'com.facebook.fbreact.specs',
  'all',
  false,
);
