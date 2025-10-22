<SYSTEM>This is the full developer documentation for React Native Unistyles 3.0</SYSTEM>

# Configuration

> How configure Unistyles

To unlock more features and tailor Unistyles to your needs, you can configure it. The Unistyles configuration is divided into three parts:

1. **Themes**
2. **Breakpoints**
3. **Settings**

Note

Each configuration is optional but enables advanced features, which are explained in the guide [How Unistyles Works?](/v3/start/how-unistyles-works)

### Themes (Optional)

`Themes` is a JavaScript object where the keys represent unique theme names, and the values are the corresponding theme definitions. For more details, refer to the [theming](/v3/guides/theming) guide.

unistyles.ts

```tsx
const lightTheme = {
    colors: {
        primary: '#ff1ff4',
        secondary: '#1ff4ff'
        // any nesting, spreading, arrays, etc.
    },
    // functions, external imports, etc.
    gap: (v: number) => v * 8
}


const otherTheme = {
    colors: {
        primary: '#aa12ff',
        secondary: 'pink'
    },
    gap: (v: number) => v * 8
}


const appThemes = {
    light: lightTheme,
    other: otherTheme
}
```

Note

Unistyles supports any dynamic theme and doesn’t enforce a specific structure. To avoid TypeScript issues, ensure that all themes share the same type.

### Breakpoints (Optional)

`Breakpoints` is a JavaScript object where the keys are unique breakpoint names and the values are the corresponding breakpoint values (numbers). Be sure to register at least one breakpoint with a value of 0, as it’s required to simulate the cascading behavior of CSS media queries.

unistyles.ts

```tsx
const breakpoints = {
    xs: 0, // <-- make sure to register one breakpoint with value 0
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
    // use as many breakpoints as you need
}
```

### Settings (Optional)

The `Settings` object has been simplified, and in the most recent version, it supports only four properties:

* **`adaptiveThemes`** – a boolean that enables or disables adaptive themes [learn more](/v3/guides/theming#adaptive-themes)
* **`initialTheme`** – a string or a synchronous function that sets the initial theme
* **`CSSVars`** – a boolean that enables or disables web CSS variables (defaults to `true`) [learn more](/v3/references/web-only#css-variables)
* **`nativeBreakpointsMode`** - iOS/Android only. User preferred mode for breakpoints. Can be either `points` or `pixels` (defaults to `pixels`) [learn more](/v3/references/breakpoints#pixelpoint-mode-for-native-breakpoints)

unistyles.ts

```tsx
const settings = {
    initialTheme: 'light'
}


// or with a synchronous function
const settings = {
    initialTheme: () => {
        // get preferred theme from user's preferences/MMKV/SQL/StanJS etc.


        return storage.getString('preferredTheme') ?? 'light'
    }
}


// or with adaptive themes
const settings = {
    adaptiveThemes: true
}
```

Note

In the Unistyles 3.0 setting both `initialTheme` and `adaptiveThemes` will cause an error. These options are mutually exclusive.

### TypeScript Types (Optional)

If your repository is using TypeScript, it is highly recommended to override the library types for optimal autocomplete and type safety regarding your themes and breakpoints:

unistyles.ts

```tsx
type AppThemes = typeof appThemes
type AppBreakpoints = typeof breakpoints


declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes {}
    export interface UnistylesBreakpoints extends AppBreakpoints {}
}
```

### Set configuration

The final step in the configuration is to set all the options by calling the `StyleSheet.configure` function:

unistyles.ts

```tsx
import { StyleSheet } from 'react-native-unistyles'


StyleSheet.configure({
    themes: appThemes,
    breakpoints,
    settings
})
```

That’s it! You can now use all the features of Unistyles in your project!

Note

Don’t forget to import this config somewhere in your project, for example in `index.ts` file. You **must** call `StyleSheet.configure` **before** any `StyleSheet.create` call.

For expo router users, please refer to the [Expo Router guide](/v3/guides/expo-router).

### Full example

unistyles.ts

```tsx
import { StyleSheet } from 'react-native-unistyles'


const lightTheme = {
    colors: {
        primary: '#ff1ff4',
        secondary: '#1ff4ff'
    },
    gap: (v: number) => v * 8
}


const otherTheme = {
    colors: {
        primary: '#aa12ff',
        secondary: 'pink'
    },
    gap: (v: number) => v * 8
}


const appThemes = {
    light: lightTheme,
    other: otherTheme
}


const breakpoints = {
    xs: 0,
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
}


type AppBreakpoints = typeof breakpoints
type AppThemes = typeof appThemes


declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes {}
    export interface UnistylesBreakpoints extends AppBreakpoints {}
}


StyleSheet.configure({
    settings: {
        initialTheme: 'light',
    },
    breakpoints,
    themes: appThemes
})
```

# Getting started

> How to get started with Unistyles

We’ve made Unistyles incredibly easy to use. You no longer need the `useStyle` hook or wrap your app in React Provider. Unistyles integrates seamlessly with your existing code, so you can start using it immediately.

### Prerequisites

Unistyles 3.0 is tightly integrated with `Fabric` and the latest versions of React Native. Therefore, you must use the **New Architecture** and at least **React Native 0.78.0**. Additionally, Unistyles relies on `react-native-nitro-modules` and `react-native-edge-to-edge`.

Note

Learn more about how Unistyles leverages Nitro Modules and React Native Edge to Edge [here](/v3/other/dependencies).

**Table of requirements:**

|                  | Required                  | Note                      |
| ---------------- | ------------------------- | ------------------------- |
| React Native     | 0.78.0+                   |                           |
| New Architecture | enabled                   | no option to opt-out      |
| Expo SDK         | 53+                       | (if you use Expo)         |
| Xcode            | 16+ (recommended 16.3+)   | Required by Nitro Modules |
| Platform         | iOS / Android / Web / SSR | Follow instructions below |

Since Unistyles relies on `Fabric`, it cannot run on the `Old Architecture` or older versions of React Native. If you can’t meet these requirements, you can use Unistyles 2.0+, which is compatible with those versions.

### Installation

Install Unistyles and its dependencies

```shell
yarn add react-native-unistyles react-native-nitro-modules react-native-edge-to-edge
```

Caution

To avoid unexpected behaviors always use a fixed version of `react-native-nitro-modules`. Check compatibility table [here](https://github.com/jpudysz/react-native-unistyles?tab=readme-ov-file#installation).

Add babel plugin:

babel.config.js

```js
module.exports = function (api) {
  api.cache(true)


  return {
    // for bare React Native
    // presets: ['module:@react-native/babel-preset'],


    // or for Expo
    // presets: ['babel-preset-expo'],


    // other config
    plugins: [
        // other plugins
        ['react-native-unistyles/plugin', {
            // pass root folder of your application
            // all files under this folder will be processed by the Babel plugin
            // if you need to include more folders, or customize discovery process
            // check available babel options
            root: 'src'
        }]
    ]
  }
}
```

Note

See additional Babel plugin configuration options [here](/v3/other/babel-plugin#extra-configuration).

Learn why you need Babel plugin [here](/v3/other/babel-plugin).

Finish installation based on your platform:

* Expo

  ```shell
  yarn expo prebuild --clean
  ```

  Do you use Expo Router?

  Finish installation for Expo Router [here](/v3/guides/expo-router).

  Dev client only

  Unistyles includes custom native code, which means it does not support **Expo Go.**

* React Native

  ```shell
  cd ios && pod install
  ```

* React Native Web

  Unistyles offers first-class support for React Native Web. To run the project, we recommend following the guidelines provided by [Expo](https://docs.expo.dev/workflow/web/).

* Custom Web

  You can use Unistyles without React Native Web as a dependency. Check [this guide](/v3/guides/custom-web) for more details.

* SSR

  Unistyles offers first-class support for Next.js Server Side Rendering. To run the project, we recommend following the guidelines provided by [Next.JS](https://nextjs.org/docs).

  Then follow [SSR guide](/v3/guides/server-side-rendering).

  Babel only

  You need to disable SWC and rely on Babel for transpiling your code.

### As easy as React Native StyleSheet

Getting started with Unistyles couldn’t be easier. Simply replace React Native’s `StyleSheet` with the `StyleSheet` exported from Unistyles. From that moment, you’ll be using a `StyleSheet` with superpowers 🦸🏼‍♂️.

Example.tsx

```tsx
 import { StyleSheet } from 'react-native'
 import { StyleSheet } from 'react-native-unistyles'


const MyComponent = () => {
  return (
    <View style={styles.container}>
      <Text>Hello world from Unistyles</Text>
    </View>
  )
}


const styles = StyleSheet.create({
   container: {
     backgroundColor: 'red'
   }
})
```

By replacing `StyleSheet`, you immediately gain several benefits that aren’t available in React Native’s `StyleSheet`:

* [Variants](/v3/references/variants)
* [Compound variants](/v3/references/compound-variants)
* [Dynamic functions](/v3/references/dynamic-functions)
* [Media queries](/v3/references/media-queries)
* [Horizontal and vertical breakpoints for Native](/v3/references/breakpoints#built-in-breakpoints-landscape-and-portrait)
* [Custom web styles](/v3/references/web-styles)
* [Web only features](/v3/references/web-only)

When you’re ready to customize your styles and unlock additional features you can [configure](/v3/start/configuration) Unistyles.

# How Unistyles works?

> Understanding how Unistyles 3.0 works

To get the most out of Unistyles, it’s important to understand how it works and how it updates your styles.

### 1. StyleSheets

A typical app consists of many `StyleSheets`. A `StyleSheet` is a JavaScript object that holds one or many styles. Each style is associated with a native view. What’s more important is that each `StyleSheet` is unique, tailored to the needs of the view, or to a shared component.

![](/_astro/how-1.ClhanbTT.png)

Your app’s StyleSheets

### 2. Babel plugin: dependencies

Unistyles needs to understand your `StyleSheet` dependencies in order to update them only when necessary. This process begins when Babel transforms your app’s code. At this stage, the Unistyles Babel plugin scans your `StyleSheets` and determines the dependencies for each style:

```ts
const styles = StyleSheet.create((theme, rt) => ({
  // static: no dependencies
  container: {
    backgroundColor: 'red',
  },
  // depends on theme and font scale
  text: {
    color: theme.colors.text,
    fontSize: rt.fontScale * 16
  },
  dynamic: (isOdd: boolean) => ({
    // depends on theme
    color: isOdd ? theme.colors.primary : theme.colors.secondary,
  })
})
```

### 3. Babel plugin: component factory

As you already know, Unistyles has no components. This means your native view hierarchy remains exactly the same as in your original code. The Babel plugin processes your components through our component factory to borrow `refs` and bind the `ShadowNode` with `Unistyle`.

You might be wondering, what is `Unistyle`? We refer to it as your `StyleSheet` style that has been parsed by the Unistyles compiler, and with the attached `C++` state.

![](/_astro/how-2.CKBxY89P.png)

Your styles are transformed into Unistyles

Note

Learn more on how the Babel plugin works [here](/v3/other/babel-plugin).

### 4. StyleSheet registry

We don’t just extract metadata from your styles. We do the same for your `StyleSheet`. On the C++ side, we know exactly which `StyleSheet` is static, which depends on a `theme`, and which `Unistyles` it contains. At this point, your app’s `StyleSheets` are reconstructed on the C++ side and stored in native C++ `StyleSheets`, which contain the parsed `Unistyles`.

![](/_astro/how-3.C8JEACBb.png)

C++ StyleSheets that contain parsed styles (Unistyles)

To make this process easier to visualize, imagine that the Unistyles engine is a production line. It takes your raw `StyleSheets`, parses them, and produces their C++ representation with `Unistyles`:

![](/_astro/how-4.DbcKjxwq.png)

Unistyles workflow

### 5. Reacting to events

When you access your `StyleSheet` styles in your component, you’ll get a regular JS object as expected. If your component re-renders, we simply return the same `Unistyle` that’s already parsed and stored in the cache.

To visualize the true power of `Unistyles`, imagine that some event occurs, such as:

* A theme change triggered by the user clicking a button
* A phone color scheme change
* A phone orientation change
* Accessibility settings being updated
* and much more! Unistyles can update your styles based on 16 different events

At this point, the Unistyles algorithm scans the `StyleSheetRegistry` and looks for styles that depend on this event:

![](/_astro/how-5.Bu7A8bBJ.png)

Finding affected styles

Affected styles are then re-computed to reflect the new state of your app.

### 6. Shadow Tree updates

With the list of affected styles, we can now browse the `ShadowRegistry`, where we keep the bindings between `ShadowNode` and `Unistyles`. In other words, we know which `component` relies on which `style`. With all this information, we can translate the update into atomic `ShadowTree` instructions.

With Unistyles 2.0 or any other library, we would need to re-render your entire app to reflect the changes:

![](/_astro/how-6.D5izBS6T.png)

Regular flow: your app is re-rendered

Instead, with all the optimizations and features that Unistyles 3.0 brings, we can target only specific nodes and update your `ShadowTree` directly from C++:

![](/_astro/how-7.DHJpQ7un.png)

Unistyles 3.0 updates only selected ShadowNodes from C++

With this architecture and the power of selective updates through `ShadowTree`, your components are never re-rendered.

*Engineering is the closest thing to magic that exists in the world.*

\~Elon Musk

# Introduction

> Welcome to Unistyles!

![](/_astro/uni2.CWBtkH-A.png)

Unistyles is a cross-platform library that enables you to share up to 100% of your styles across all platforms. It combines the simplicity of `StyleSheet` with the performance of `C++`.

**`Unistyles` is a superset of `StyleSheet`** similar to how `TypeScript` is a superset of `JavaScript`. If you’re familiar with styling in React Native, then you already know how to use `Unistyles`.

### Why should you use Unistyles?

* Guarantees no re-renders across the entire app (no hooks, no context—just pure JSI bindings)
* Doesn’t pollute your native view hierarchy, you can use any component you want
* Includes a cross-platform parser written in C++, ensuring consistent output across all platforms
* Leverages [Nitro Modules](https://nitro.margelo.com/) under the hood (everything is strongly typed!)
* Transforms your `StyleSheets` into enhanced `StyleSheets` with superpowers 🦸🏼‍♂️ that can access themes, platform-specific values, and more!
* Loved by developers worldwide: 2M+ downloads and over 2.2K stars on GitHub
* Backed by [@jpudysz](https://github.com/jpudysz) since 2023

# Migration guide

> How to migrate from previous version

The migration process is quite simple, but it can be tedious since you’ll need to remove a lot of the existing code.

1. Follow installation steps from [Getting started](/v3/start/getting-started) guide.

2. Replace your configuration with [new](/v3/start/configuration) one.

   `UnistylesRegistry` can be easily replaced with `StyleSheet.configure` as it follows the same syntax. `Themes` and `Breakpoints` work exactly the same. For `Settings` we removed 4 out of 6 options:

   ```tsx
   import { UnistylesRegistry } from 'react-native-unistyles'
   import { StyleSheet } from 'react-native-unistyles'


    UnistylesRegistry.addConfig({
       adaptiveThemes: false,
       initialTheme: 'dark',
       plugins: [...],
       experimentalCSSMediaQueries: true,
       windowResizeDebounceTimeMs: 100,
       disableAnimatedInsets: true
    })


    StyleSheet.configure({
         settings: {
             adaptiveThemes: false, // works exactly the same like in 2.0
             initialTheme: 'dark', // works exactly the same like in 2.0
             // plugins are removed, instead transform your styles with static functions
             // experimentalCSSMediaQueries: these options is also removed, and enabled by default with custom parser
             // windowResizeDebounceTimeMs: removed, there is no debouncing anymore. Styles are updated with CSS media queries
             // disableAnimatedInsets: removed, insets won't re-render your views
        }
    })
   ```

3. Import `StyleSheet` from `react-native-unistyles`:

   ```tsx
   import { createStyleSheet, useStyles } from 'react-native-unistyles'
   import { StyleSheet } from 'react-native-unistyles'
   ```

4. Replace `createStyleSheet` with `StyleSheet.create`:

   ```tsx
   const stylesheet = createStyleSheet(theme => ({
   const stylesheet = StyleSheet.create(theme => ({
   ```

5. Remove all occurrences of `useStyles` hook:

   ```tsx
   const { styles } = useStyles(stylesheet)
   ```

6. Rename your `stylesheet` to `styles`:

   ```tsx
   const stylesheet = StyleSheet.create(theme => ({
   const styles = StyleSheet.create(theme => ({
   ```

7. If you used `useInitialTheme`, remove it and set initial theme in `StyleSheet.configure`:

   ```tsx
   import { StyleSheet } from 'react-native-unistyles'


   StyleSheet.configure({
       themes,
       breakpoints,
       settings: {
           initialTheme: () => {
               // get preferred theme from user's preferences/MMKV/SQL/StanJS etc.
               // must be synchronous
               return storage.getString('preferredTheme') ?? 'light'
           }
       }
   })
   ```

8. If you need to access your `theme` in component, refactor it to use `withUnistyles`:

   ```tsx
   import { Button } from 'react-native'
   import { useStyles } from 'react-native-unistyles'
   import { withUnistyles } from 'react-native-unistyles'


   const UniButton = withUnistyles(Button, theme => ({
       color: theme.colors.primary
   }))


   const MyButton = () => {
       return <UniButton />
   }


   const MyButton = () => {
       const { theme } = useStyles(stylesheet)


        return <Button color={theme.colors.primary} />
       return <UniButton />
   }
   ```

9. If you want to speed up the migration process, but keep your views re-rendered, use [useUnistyles](/v3/references/use-unistyles) hook:

   ```tsx
   import { Button } from 'react-native'
   import { useUnistyles } from 'react-native-unistyles'


   const MyText = () => {
       const { theme } = useUnistyles()


       return (
           <Button color={theme.colors.primary} />
       )
   }
   ```

10. If you need to access `breakpoint` to show/hide your components use `Display` and `Hide` components instead:

    ```tsx
    import { Text } from 'react-native'
    import { Display, Hide, mq } from 'react-native-unistyles'


    const MyText = () => {
        return (
            <Display mq={mq.only.width(0, 400)}>
                <Text>This text is visible on small devices</Text>
            </Display>
            <Hide mq={mq.only.width(400)}>
                <Text>This text is hidden on big devices</Text>
            </Hide>
        )
    }
    ```

11. If you used `UnistylesProvider`, remove it as it’s not available anymore:

    ```tsx
    import { UnistylesProvider } from 'react-native-unistyles'


    <UnistylesProvider>
        <App />
    </UnistylesProvider>
    ```

12. If you want to move your component based on keyboard position, use `ime` inset:

    ```tsx
    const style = StyleSheet.create({
        container: {
          paddingBottom: rt.insets.bottom // bottom is no longer dynamic
          paddingBottom: rt.insets.ime
        }
    })
    ```

13. Some `UnistylesRuntime` methods have been renamed. Follow TypeScript types to use new names.

14. Some `UnistylesRuntime` methods have been removed:

    ```tsx
    UnistylesRuntime.addPlugin(plugin) // Unistyles has no plugins anymore
    UnistylesRuntime.removePlugin(plugin) // Unistyles has no plugins anymore
    UnistylesRuntime.statusBar.setColor(color) // removed due to Android 15 deprecation
    UnistylesRuntime.navigationBar.setColor(color) // removed due to Android 15 deprecation
    ```

15. `UnistylesRuntime` methods that accepted `color` and `alpha` have been changed to accept `color` only. Each method supports **any** color that is respected by React Native:

    ```tsx
    UnistylesRuntime.setRootViewBackgroundColor(color, alpha) // no need for separate alpha
    UnistylesRuntime.setRootViewBackgroundColor(color) // accepts any color
    ```

16. `hairlineWidth` has been moved from `UnistylesRuntime` to `StyleSheet`. Use `StyleSheet.hairlineWidth` instead:

    ```tsx
    UnistylesRuntime.hairlineWidth // no longer available
    StyleSheet.hairlineWidth // matches StyleSheet API
    ```

17. If your app used variants, move config to `styles.useVariants` instead:

    ```tsx
     import { useStyles } from 'react-native-unistyles'
     import { StyleSheet } from 'react-native-unistyles'


    const MyComponent = () => {
       const { styles } = useStyles(stylesheet, {
           variant1: 'primary',
           variant2: 'secondary'
       })
       styles.useVariants({
           variant1: 'primary',
           variant2: 'secondary'
       })


        return <View style={styles.container} />
    }
    ```

18. `Style is not bound!` error or `Unistyles: we detected style object with N unistyles styles. (...)` warning

    If you encountered this warning or error, it means that you’re spreading your styles. This is not possible in Unistyles 3.0 anymore as spreading will remove `C++` state:

    ```tsx
    // not ok
    const styles = {...style1, ...style2}


    <View style={styles} />


    // not ok
    <View style={{...style1, ...style2}} />
    ```

    Instead, use array syntax provided by React Native:

    ```tsx
    // ok
    <View style={[style1, style2]} />
    ```

    By using array syntax, we know **the order of merging** that is necessary to resolve styles correctly.

    Learn more about [merging styles](/v3/guides/merging-styles).

# New features

> Whats new in Unistyles 3.0?

Unistyles comes packed with many exciting new features. If you’re upgrading from Unistyles 2.0, here’s a quick summary of what’s new:

1. No re-renders

   Unistyles is primarily written in `C++` with a thin `JS` layer for both iOS and Android. The key feature of this version is that it doesn’t trigger re-renders—there are no hooks, no context, just pure `JSI` bindings managing your `StyleSheet` styles. Unistyles is integrated with Fabric and the Shadow Tree, directly updating your views from C++.

2. Selective updates

   Unistyles includes a special algorithm that only recalculates styles dependent on the change. For example, if the app user switches to a dark color scheme, Unistyles will only recalculate and update the styles affected by the change.

3. Compound variants

   Unistyles extends the `variants` feature by allowing you to define `compound variants`. These are additional styles that are applied when certain conditions are met. For instance, you can define a compound variant to change the text color when the text is bold and uses the primary color.

4. Scoped themes

   You can now limit the scope of your theme to specific components, allowing different themes for different screens. For example, you can enforce a dark theme only on the login screen.

5. Custom web parser

   We’ve moved away from relying on `react-native-web` and implemented a custom parser that translates your styles into CSS classes. This parser is tailored to Unistyles syntax, including `mq`, `breakpoints`, `variants`, and `compoundVariants`. Importantly, it remains backwards compatible with React Native Web!

6. Custom CSS classes binded to styles

   For cross-platform apps, styling components like `tr` or `td` — which aren’t available in React Native can be challenging. Unistyles 3.0 allows you to define custom CSS classes that bind directly to your styles, so you can apply extra CSS styles as needed. This also means that you can use `Tailwind` implementation for your web app!

7. Pseudo-classes

   Unistyles 3.0 now supports all available CSS pseudo-classes! Easily add hover, focus, and active effects to your components.

8. Custom web styles

   If you need to style a component with web-only properties, it’s now possible. Add any CSS web property directly to your `StyleSheet` styles, such as web-based animations.

9. 1:1 parity with React Native StyleSheet

   You can now mix Unistyles with React Native StyleSheet and enable superpowers 🦸🏼‍♂️ on selected screens without additional configuration. If Unistyles doesn’t suit your needs, you can easily revert to React Native StyleSheet.

10. Support for any color format

    Unistyles now supports any color format that React Native can handle, including HEX, RGB, HSL, and more. We’ll also auto-convert your colors in any call to UnistylesRuntime.

And much more! Unistyles 3.0 is loaded with new features, so we encourage you to explore the docs and dive into the library!

# Testing

> How to test Unistyles

Unistyles provides its own mocks to help you test your components. Follow this guide to learn how to use them.

### Including Mocks

You don’t need to mock anything manually, as Unistyles supplies all necessary mocks for its core and for `NitroModules`. To use them, simply include `react-native-unistyles/mocks` in your `jest.setup.ts` file.

package.json

```tsx
{
    "jest": {
        "preset": "jest-expo",  // or use own config for bare react native
        "setupFiles": [
            "react-native-unistyles/mocks"
        ]
    }
}
```

### Include Unistyles Configuration

Each `StyleSheet` requires a configuration object passed to the `StyleSheet.configure` function. This is also true in the test environment. Extend the configuration from the previous step by including the file where you configure Unistyles.

package.json

```tsx
{
    "jest": {
        "preset": "jest-expo",
        "setupFiles": [
            "react-native-unistyles/mocks",
            "./unistyles.ts" // provide the correct path to your Unistyles configuration file
        ]
    }
}
```

Caution

You must include configuration file **after** the mocks as they provide all necessary stubs for `StyleSheet.configure`.

### Babel Plugin

The Babel plugin is automatically disabled in the `jest` test environment or when `NODE_ENV === 'test'`.

### Understanding the role of mocks

Mocks contain basic logic to correctly execute Unistyles code. The Jest environment does not provide a `screen` (width and height), pixel ratio, or any other values from `UnistylesRuntime`.

You should never test how Unistyles parses your styles, whether your component has certain styles, or if it is visible. These tests can result in false positives.

Instead, configure E2E tests using eg. Playwright or Maestro.

In these environments, you can test how Unistyles parses your styles and how your app looks like.

# When to use Unistyles 3.0?

> Learn more when should you consider using Unistyles 3.0

This guide will explain when you should consider using Unistyles and when it’s not the best option.

### When should you use Unistyles?

Unistyles is recommended for projects that:

* leverage the New Architecture and care about performance and memory usage
* use two or more themes (we support an unlimited number of themes and [adaptive themes](/v3/guides/theming#adaptive-themes))
* require rendering on the web (we [auto-generate](/v3/references/web-styles) CSS classes and variables)
* want to use [variants](/v3/references/variants) and [compound variants](/v3/references/compound-variants)
* want to use pseudo-classes and custom web styles ([learn more](/v3/references/web-only))
* feel confident with the styling patterns introduced by React Native (Unistyles follows the same approach)
* don’t want to pollute your native view hierarchy

### When is Unistyles not the best option?

* You’re looking for a component library (Unistyles has no components, instead we encourage you to build your own design system specifically tailored to your project)
* You use Tailwind on the web, as Unistyles has no native bindings to process `classNames` on the native side. Instead, we recommend using [Nativewind](https://www.nativewind.dev/)
* You’re building a super simple app that doesn’t require theme changes or any advanced features. In this case, stick with React Native’s `StyleSheet` and consider updating to Unistyles 3.0 when it will be more efficient

### When you can’t use Unistyles 3.0?

* In Expo Go apps, as Unistyles is not (yet) selected by the Expo team
* In apps that can’t update to the New Architecture. Instead, consider using [Unistyles 2.0](https://v2.unistyl.es/start/introduction/)
* In apps that target unsupported platforms (eg. TV, Windows, macOS etc.), again consider using [Unistyles 2.0](https://v2.unistyl.es/start/introduction/)

### Other alternatives

To find other alternatives, please check the latest [State of React Native survey](https://stateofreactnative.com/).

# Avoiding keyboard

> Learn how to avoid keyboard with Unistyles

Unistyles 3.0 introduces a new `inset` called `ime`, which is automatically animated when the keyboard appears or disappears. Using this inset in your style will automatically register it for future updates.

Unistyles dynamically recalculates your styles based on their dependencies. To learn more about how Unistyles re-calculates your styles, please refer to the [guide](/v3/start/how-unistyles-works).

### Usage

```tsx
import { TextInput, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


const KeyboardAvoidingView = () => {
    return (
        <View style={styles.container}>
            <TextInput style={styles.input} />
        </View>
    )
}


const styles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'flex-end',
        backgroundColor: theme.colors.backgroundColor,
        paddingHorizontal: theme.gap(2),
        paddingTop: rt.insets.top,
        transform: [
            {
                translateY: rt.insets.ime * -1
            }
        ]
    },
    input: {
        width: '100%',
    }
}))
```

In this example, the `container` will automatically adjust to avoid the keyboard, ensuring the `input` remains visible at all times.

# Custom Web

> Learn how to use Unistyles 3.0 without React Native Web

It’s possible to render Unistyles without `react-native-web` dependency by simply creating your own web-only components.

Unfortunately, you still need to install `react-native-web` in order to run your app, because most of the React Native libraries do not work without it.

For this we recommend following the guidelines provided by [Expo](https://docs.expo.dev/workflow/web/).

## How to create custom web components

In order to create custom web components, you need to use `getWebProps` function. It takes a `StyleProp` and returns an object with `className` and `ref` properties.

src/components/Header.tsx

```tsx
import { StyleProp, TextStyle } from 'react-native'
import { getWebProps } from 'react-native-unistyles/web'


type HeaderProps = {
    style: StyleProp<TextStyle>
    children: string
}


export const Header: React.FC<HeaderProps> = ({ style, children }) => {
    const { ref, className } = getWebProps(style)


    return (
        <h1
            ref={ref}
            className={className}
        >
            {children}
        </h1>
    )
}
```

Or merge multiple styles:

src/components/Header.tsx

```tsx
import { StyleProp, TextStyle } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import { getWebProps } from 'react-native-unistyles/web'


type HeaderProps = {
    customStyle: StyleProp<TextStyle>
    children: string
}


export const Header: React.FC<HeaderProps> = ({ customStyle, children }) => {
    const webProps = getWebProps([customStyle, style.text])


    return (
        <h1 {...webProps}>
            {children}
        </h1>
    )
}


const style = StyleSheet.create(theme => ({
    text: {
        color: theme.colors.text,
        _web: {
            _hover: {
                color: theme.colors.primary,
            }
        }
    }
}))
```

That’s it! Now you can use your custom web components in your app.

Caution

If you’re creating multiplatform app, remember to create a native fallback for your web components.

# Expo Router

> Integrate Expo Router with Unistyles

[Expo Router](https://docs.expo.dev/router/introduction/) is a popular routing library from Expo that is built on top of React Navigation. When using Unistyles with Expo Router, it’s necessary to configure it properly.

### Modify main entry

Expo Router resolves routes differently than expected. Also, Unistyles 3.0 is parsing your `StyleSheets` as soon as you import file containing it. This combination may cause some issues. To prevent that you need to modify your main entry file:

package.json

```json
{
   "main": "expo-router/entry"
   "main": "index.ts"
}
```

Then, create `index.ts` file with following content:

index.ts

```js
import 'expo-router/entry'
import './unistyles' // <-- file that initializes Unistyles
```

Note

The `unistyles.ts` file is where Unistyles is configured. For more details, refer to the [configuration guide](/v3/start/configuration).

With this setup, we will ensure that Unistyles is initialized before any other component.

### Expo Router Web - Static rendering

Caution

This is the default option since Expo SDK 52.

You can check if you are using static rendering in `app.json`:

app.json

```json
{
  "expo": {
    "web": {
      "bundler": "metro",
      "output": "static"
    }
  }
}
```

For Expo static rendering, every page will be resolved with the root HTML file. Unfortunately, this file is hidden, and you need to create it manually. Please follow the [Expo guide](https://docs.expo.dev/router/reference/static-rendering/#root-html) and add a `+html.tsx` file.

In this file, initialize Unistyles by importing the config file:

+html.tsx

```tsx
import React from 'react'
import { ScrollViewStyleReset } from 'expo-router/html'
import { type PropsWithChildren } from 'react'
 import '../unistyles' // <-- file that initializes Unistyles


export default function Root({ children }: PropsWithChildren) {
    ...
}
```

This ensures that Unistyles is initialized whenever Expo Router renders the next static page.

# Merging styles

> Learn about how to merge styles with Unistyles 3.0

While using Unistyles, it’s crucial to understand how styles need to be merged and why it is so important.

### Introduction

In the early versions of Unistyles 3.0, we tried to solve this issue with a Babel plugin. However, it was too complex to maintain various edge cases (especially with `Pressable`), and developers frequently encountered many `Unistyles: Style is not bound!` errors.

With the new approach, we shift the responsibility of merging styles to the user. In other words, the Babel plugin will no longer convert your style tags from objects to arrays.

### How to merge multiple styles

Unistyles doesn’t provide any extra API for merging styles. Instead, we encourage you to use the `[]` syntax supported by React Native components.

```tsx
<View style={[styles.container, styles.container2]} />
```

If Unistyles detects that you’ve used the spread operator and the styles have no attached C++ state, it will:

* Restore the state on the C++ side
* Merge styles in an unpredictable order (as we lose order information)
* Warn you in `__DEV__` mode about this

Example error

Unistyles: We detected a style object with 2 Unistyles styles. This might cause no updates or unpredictable behavior. Please check the `style` prop for `View` and use array syntax instead of object syntax.

When you see this warning, your component will render correctly, but any new event that re-computes your styles could:

* Output incorrect styles due to the unknown order of merging
* Not update at all if during the merging process, you altered props that were previously listening for changes

It’s critical to ship Unistyles 3.0 apps without this warning, as it can cause unexpected behavior.

### Reanimated

In older versions of Reanimated, the `Animated` component was flattening your styles array, causing warnings and only allowing to pass a **single** unistyles to an `Animated` component ([original issue](https://github.com/jpudysz/react-native-unistyles/issues/512)).

However, from `react-native-reanimated@3.17.2` or `react-native-reanimated@4.0.0-beta.3`, styles are no longer flattened.

### Spreading a single Unistyle

Another problematic case is spreading a single Unistyle and merging it, e.g., with inline styles:

```tsx
<View style={{...styles.container, ...{ backgroundColor: 'red' }}} />
```

Although we can restore the C++ state for `styles.container`, we cannot identify that `backgroundColor: red` should override the `backgroundColor` used in `styles.container`. The order of merging will be preserved until the first re-computation of styles.

Also, keep in mind that restoring the C++ state takes unnecessary extra time, so it’s better to avoid it.

### Summary

* Use the `[]` syntax to merge styles
* Avoid spreading Unistyles
* Avoid merging your styles with the spread operator
* Unistyles will warn you about this in `__DEV__` mode

With this new approach, you’re in control of merging your styles.

# React Compiler

> Integrate React Compiler with Unistyles

React Compiler is a build-time tool that automatically optimizes your React app. To integrate Unistyles with React Compiler, proper configuration is essential.

## With Expo

For Expo projects, simply follow the [official Expo guide](https://docs.expo.dev/guides/react-compiler/). No additional configuration changes are necessary!

## With Bare React Native

For bare React Native projects, refer to the [official React guide](https://react.dev/learn/react-compiler#usage-with-babel) with one key adjustment:

Ensure that the React Compiler runs *after* the Unistyles Babel plugin. Failure to do so may result in errors because Unistyles needs to process `Variants` before the React Compiler does. You can read more about the Babel plugin [here](/v3/other/babel-plugin).

Here’s a sample configuration for your `babel.config.js`:

babel.config.js

```js
module.exports = function () {
  return {
    plugins: [
      ['react-native-unistyles/plugin'], // Must run before react-compiler
     'babel-plugin-react-compiler',
      // Add other plugins here
    ]
  }
}
```

# Reanimated

> Learn how to use Unistyles 3.0 with Reanimated

Unistyles works seamlessly with `react-native-reanimated`. Learn best practices for combining both libraries.

Note

Reanimated works the best with Unistyles in:

* `react-native-reanimated@3.17.3` and above
* `react-native-reanimated@4.0.0-beta.3` and above

### Access theme in worklets

Using the theme from `UnistylesRuntime.getTheme()` will not trigger worklet updates. Importing it from `useUnistyles` will cause a re-render.

That’s why to use Unistyles theme in worklets (e.g. in `useAnimatedStyle`), you need to import a special hook from `react-native-unistyles/reanimated`.

```tsx
import { useAnimatedTheme } from 'react-native-unistyles/reanimated'
import Animated, { useAnimatedStyle, interpolate } from 'react-native-reanimated'


export const MyAnimatedComponent = () => {
    const theme = useAnimatedTheme()
    const style = useAnimatedStyle(() => ({
        backgroundColor: theme.value.colors.background,
        // other animated styles
    }))


    return (
        <Animated.View style={style} />
    )
}
```

Note

`useAnimatedTheme` is a first-class `SharedValue`, so you can use it in worklets. It also triggers worklet updates if any change occurs and doesn’t cause re-renders.

### Animating variant colors

It’s possible to reuse Unistyles variant colors and animate them using the `useAnimatedStyle` hook.

Define your variants with a `color` property:

Note

You can animate any prop that contains a `color` property.

```tsx
const styles = StyleSheet.create((theme, rt) => ({
    styleWithVariants: {
        height: 100,
        width: 100,
        variants: {
            variant: {
                red: {
                    backgroundColor: theme.colors.primary
                },
                blue: {
                    backgroundColor: theme.colors.secondary
                }
            }
        }
    }
}))
```

In this case, `styleWithVariants` can transition the `backgroundColor` property from `primary` to `secondary` and vice versa.

Import the `useAnimatedVariantColor` hook to animate variant colors:

```tsx
import { useAnimatedVariantColor } from 'react-native-unistyles/reanimated'


// Select backgroundColor from styles.styleWithVariants (TypeScript will infer all possible color properties)
const color = useAnimatedVariantColor(styles.styleWithVariants, 'backgroundColor')
const animatedStyle = useAnimatedStyle(() => {
    return {
        // color is a SharedValue that can be animated however you want
        backgroundColor: withTiming(color.value, {
            duration: 500
        })
    }
})
```

`useAnimatedVariantColor` also respects theme and breakpoint changes and will animate to the new color automatically.

### Merging styles

When you want to use `Unistyles` styles in `Animated` components, never mix them with `Reanimated` styles:

```tsx
import { StyleSheet } from 'react-native-unistyles'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'


export const MyAnimatedComponent = () => {
    const style = useAnimatedStyle(() => ({
        ...styles.container, // never do that! 💥
        // other animated styles
    }))


    return (
        <Animated.View style={style} />
    )
}


const style = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.background,
    }
}))
```

This will produce a single style with both `Unistyles` C++ state and `Reanimated` animation metadata, which might cause performance issues at the `ShadowTree` level (both libraries will animate and override the same style nodes).

Instead, separate both styles:

```tsx
import { StyleSheet } from 'react-native-unistyles'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'


export const MyAnimatedComponent = () => {
    const animatedStyles = useAnimatedStyle(() => ({
        // animated styles
    }))


    return (
        <Animated.View style={[styles.container, animatedStyles]} /> // ✅ Good!
    )
}


const style = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.background,
    }
}))
```

With this approach, both libraries will focus on updating own styles, which will result in better performance.

# SSR

> Learn about SSR with Unistyles 3.0

Unistyles 3.0 is fully compatible with Next.js Server Side Rendering (SSR). We’re supporting both client and server components.

### Usage

* App router

  To use server-side rendered styles, create the following **client-side** component:

  Style.tsx

  ```tsx
  'use client'


  import { PropsWithChildren, useRef } from 'react'
  import { useServerUnistyles } from 'react-native-unistyles/server'
  import { useServerInsertedHTML } from 'next/navigation'
  import './unistyles'


  export const Style = ({ children }: PropsWithChildren) => {
      const isServerInserted = useRef(false)
      const unistyles = useServerUnistyles()


      useServerInsertedHTML(() => {
          if (isServerInserted.current) {
              return null
          }


          isServerInserted.current = true


          return unistyles
      })


      return <>{children}</>
  }
  ```

  With the component in place, make sure it wraps your body’s children:

  layout.tsx

  ```tsx
   import '../unistyles'
   import { Style } from '../Style'


  export default function RootLayout({
  children,
  }: Readonly<{
  children: React.ReactNode;
  }>) {
  return (
      <html lang="en">
      <body>
          <Style>
              {children}
          </Style>
      </body>
      </html>
  );
  }
  ```

  Note

  The `unistyles.ts` file is where Unistyles is configured. For more details, refer to the [configuration guide](/v3/start/configuration).

  With this setup, we will ensure that Unistyles is initialized correctly and injects CSS on the server-side.

  ### Config (Optional)

  `useServerUnistyles` accepts an optional config object:

  * **`includeRNWStyles`** – a boolean that enables or disables injecting React Native Web default CSS styles. Defaults to `true`.

* Pages router

  To use server-side rendered styles, add the following code to your codebase:

  \_document.tsx

  ```tsx
  import { getServerUnistyles, resetServerUnistyles } from 'react-native-unistyles/server'


    export default class Document extends NextDocument {
        static async getInitialProps({ renderPage }: DocumentContext) {
            const page = await renderPage()
            const styles = getServerUnistyles()


            resetServerUnistyles()


            return {
                ...page,
                styles
            }
        }
  ```

  And add the following use effect to your `_app.tsx`

  \_app.tsx

  ```tsx
   import { hydrateServerUnistyles } from 'react-native-unistyles/server'


  {/* JSX of your component */}
   useEffect(() => {
       hydrateServerUnistyles()
   }, [])
  ```

  ### Config (Optional)

  `getServerUnistyles` accepts an optional config object:

  * **`includeRNWStyles`** – a boolean that enables or disables injecting React Native Web default CSS styles. Defaults to `true`.

## Troubleshooting

### Hydration error

If you’re not using adaptive themes, you might encounter hydration error on your root html element. This is because unistyles is adding a className to it based on the current theme.

To fix this simply add `suppressHydrationWarning` to your root html element.

layout.tsx

```tsx
<html lang="en">
<html lang="en" suppressHydrationWarning>
```

Or you can directly add the className to your root html element.

layout.tsx

```tsx
<html lang="en">
<html lang="en" className="dark">
```

# Theming

> Best practices for theming in Unistyles

Theming in `Unistyles` differs from other libraries as it doesn’t impose any specific syntax.

**Any JavaScript object can be a Unistyles theme**.

There is also no limit to the number of themes. You can even register dozens of them eg. when you needs to support some premium ones.

Theming is optional. If you don’t register themes with [StyleSheet.configure](/v3/start/configuration#themes-optional) the library will use an empty object by default.

### Create a theme

You can organize your themes however you want:

```tsx
const myTheme = {
    // any keys
    colors: {
        // your colors
    },
    components: {
        // any number of nesting
        button: {
            deepKey: {}
        }
    },
    utils: {
        // you can even use functions here
        hexToRGBA: () => {}
    },
    // or compute your themes with functions and spread operators
    ...premiumFeatures,
    ...getMyColors()
}
```

Note

It’s also possible to update the theme during runtime. Please check `updateTheme` method in the [UnistylesRuntime](/v3/references/unistyles-runtime) guide.

If you use TypeScript you need to override the library’s type:

```tsx
type AppThemes = {
  name: typeof myTheme
}


declare module 'react-native-unistyles' {
  export interface UnistylesThemes extends AppThemes {}
}
```

Finally, to register the theme, you need to call `StyleSheet.configure`:

```tsx
import { StyleSheet } from 'react-native-unistyles'
import { myTheme } from './themes'


StyleSheet.configure({
    themes: {
        name: myTheme,
        // you can add more themes here
    }
})
```

Where `name` is the unique name of your theme.

Note

It’s not recommended to use themes with different shapes. Unistyles allows that, but it might cause some TypeScript errors.

### Select theme

If you’ve registered more than one theme, Unistyles won’t know which one is the initial one. At this point, you have 3 options:

* If you know the initial theme upfront, select it with `settings` from [StyleSheet.configure](/v3/start/configuration#settings-optional)

```tsx
StyleSheet.configure({
    settings: {
        initialTheme: 'premium'
    }
})
```

* If you need to resolve the user-selected theme during runtime, use a synchronous function:

```tsx
StyleSheet.configure({
    settings: {
        initialTheme: () =>  {
            // get preferred theme from user's preferences/MMKV/SQL/StanJS etc.
            return storage.getString('preferredTheme') ?? 'light'
        }
    }
})
```

Note

It’s not possible to use `async` functions with `initialTheme` option.

* Use adaptive themes, which are described below

### Get the current theme

To get the current theme you can access it in the `StyleSheet.create` function:

```tsx
const styles = StyleSheet.create(theme => ({
    ...
}))
```

Other, discouraged way is to access it in the hook `useUnistyles`:

```tsx
import { useUnistyles } from 'react-native-unistyles'


const MyComponent = () => {
    const { theme } = useUnistyles()


    return (
        <Text>
            My theme is {theme.colors.primary}
        </Text>
    )
}
```

Caution

`useUnistyles` is not recommended as it will re-render your component on every change of the theme. Learn more about [useUnistyles](/v3/references/use-unistyles)

### Get the current theme name

To get the current theme name, import `UnistylesRuntime`:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// access the current theme name in your component
export const UserTheme = () => (
    <Text>
        Selected theme is {UnistylesRuntime.themeName}
    </Text>
)
```

### Adaptive themes

Adaptive themes allow Unistyles to automatically manage the selection of your themes based on device color scheme settings. To enable this, you need to meet two conditions:

* register two themes with reserved names `light` and `dark`:

```tsx
StyleSheet.configure({
    themes: {
        light: lightTheme,
        dark: darkTheme,
        // you may have more themes
    }
})
```

* Explicitly enable `adaptiveThemes`:

```tsx
StyleSheet.configure({
    themes: {
        light: lightTheme,
        dark: darkTheme
    },
    settings: {
        adaptiveThemes: true
    }
})
```

Caution

Setting initial theme and enabling adaptive themes at the same time will throw an error as this options are mutually exclusive.

### Toggle adaptive themes during runtime

To toggle adaptive themes support at any point, use `UnistylesRuntime`:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// toggle support for adaptive themes at any point
export const ToggleAdaptiveThemes = () => (
    <Button
        title="Disable adaptive themes"
        onPress={() => UnistylesRuntime.setAdaptiveThemes(false)}
    />
)
```

With adaptive themes disabled, you can now manually change the theme.

### Check if adaptive themes are enabled

To check if adaptive themes are enabled, use `UnistylesRuntime` again:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// check if you've enabled adaptive themes
export const AdaptiveThemes = () => (
    <Text>
        Adaptive themes are {UnistylesRuntime.hasAdaptiveThemes ? 'enabled' : 'disabled'}
    </Text>
)
```

### Get device color scheme

Check your device color preference with `UnistylesRuntime`:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// check the current device scheme preference
export const UserTheme = () => (
    <Text>
        My device is using the {UnistylesRuntime.colorScheme} scheme.
    </Text>
)
```

Available options are: `dark`, `light` or `unspecified` for devices that don’t support color schemes.

Caution

Unistyles will read your device settings, not user preferences. It’s not compatible with the React Native `Appearance` module.

If your app’s theme is not changing based on device settings, please refer to the [FAQ](/v3/other/frequently-asked-questions/#adaptive-mode-doesnt-work-for-me)

### Change theme

To change the theme at any time, simply call `setTheme` function:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// change the theme in any component
export const ChangeTheme = () => (
    <Button
        title="Change theme"
        onPress={() => UnistylesRuntime.setTheme('dark')}
    />
)
```

Caution

Calling this function with enabled adaptive themes will throw an error.

### Update theme during runtime

Unistyles allows you to update your theme during runtime. This is useful if you want to show the user interface with default colors and later alter theme based on user preferences.

If you update the currently selected theme, it will be automatically applied, and Unistyles will notify all stylesheets about the change. Otherwise, theme will be updated silently.

To update the theme during runtime, call `updateTheme` function, and return new theme object:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// update the theme at any time
export const UpdateTheme = ({ selectedColors }) => (
    <Button
        title="Update theme"
        onPress={() => UnistylesRuntime.updateTheme('dark', currentTheme => ({
            ...currentTheme,
            colors: {
                ...currentTheme.colors,
                ...selectedColors
            }
        }))}
    />
)
```

### Update rootView background color during runtime

You can also change dynamically the root view background color with `UnistylesRuntime`:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// update the theme at any time
export const UpdateTheme = ({ selectedColors }) => (
    <Button
        title="Update theme"
        onPress={() => UnistylesRuntime.setRootViewBackgroundColor(theme.colors.primary)}
    />
)
```

Changing rootView background color is useful when your app supports different orientations and you want to match the background color with your theme while transitioning.

Note

Unistyles supports all colors that React Native supports eg. #FFFFFF, rgba(255, 255, 255, 0.5), red etc.

# Why my view doesn't update?

> Learn how to resolve the issue when your view is not updating as expected

If you start working with Unistyles 3.0, it might be unclear why some views are updated while others aren’t. Before diving into this guide, make sure you’ve read the other guides covering the basics of the new Unistyles:

* [Look under the hood](/v3/start/how-unistyles-works)
* [Merging styles](/v3/guides/merging-styles)
* [Babel plugin](/v3/other/babel-plugin)

### Problem 1: Babel

To leverage ShadowTree updates and avoid unnecessary re-renders, Unistyles must process both `StyleSheets` and your components. By default, the Babel plugin looks for `react-native-unistyles` imports and always ignores the `node_modules` folder.

If you separate `StyleSheets` from your components, it’s your responsibility to configure Babel to detect components that lack a Unistyles import. We’ve added plenty of options, so be sure to [check them out](/v3/other/babel-plugin##extra-configuration).

### Problem 2: Dependency detection

Unistyles will automatically detect all your dependencies for every `StyleSheet`, but there’s a chance you used custom syntax that isn’t covered by the plugin. If Babel fails to detect some style dependencies, they won’t be updated when necessary.

You can easily debug this issue by adding the following Babel plugin configuration:

babel.config.js

```js
module.exports = function (api) {
  api.cache(true)


  return {
    // other config
    plugins: [
        // other plugins
        ['react-native-unistyles/plugin', {
            root: 'src',
            debug: true // add this option
        }]
    ]
  }
}
```

Then, restart the Metro server cache and check the console, where you’ll find every file and style with its detected dependencies.

### Problem 3: Non React Native components

Unistyles can only update React Native components. If you’re using a third-party component, you’ll need to apply a different strategy. Follow our [decision algorithm](/v3/references/3rd-party-views) to help you choose the best approach.

### Problem 4: Web styles are not applied

This issue indicates that the Babel plugin didn’t detect some of your components. Initially, it may seem like native styles are working correctly, but that’s not the case.

On mobile, styles are returned the same way as in React Native. You can always `console.log` them to inspect the parsed values:

mobile

```tsx
export const MyView: React.FunctionComponent = () => {
    console.log(styles.container) // { backgroundColor: 'red' }


    return (
        ...
    )
}


const styles = StyleSheet.create({
    container: {
        backgroundColor: 'red'
    }
})
```

For the web, styles are not returned directly, as they are converted into CSS classes. If you try to log them, there will be no output:

web

```tsx
export const MyView: React.FunctionComponent = () => {
    console.log(styles.container) // {}


    return (
        ...
    )
}


const styles = StyleSheet.create({
    container: {
        backgroundColor: 'red'
    }
})
```

That’s why you might mistakenly think the problem is only on the web. Please follow the [Babel config](/v3/other/babel-plugin##extra-configuration) to ensure all your components and StyleSheets are detected correctly.

# How to auto-update 3rd party views?

> Learn how to use Unistyles with 3rd party components

Tip

This is our decision algorithm to ensure best practices for your app.

1. If you’re using `react-native` or `react-native-reanimated` components with `style` prop, avoid doing anything. It will work out of the box.

2. For `react-native` components with `contentContainerStyle` prop, you can use the [withUnistyles](/v3/references/with-unistyles) factory. Wrapping your component in `withUnistyles` will [auto map](/v3/references/with-unistyles#auto-mapping-for-style-and-contentcontainerstyle-props) `contentContainerStyle` prop.

3. If you’re using third-party components and you’re confident they internally use `react-native` components, check the [Babel plugin configuration](/v3/other/babel-plugin#extra-configuration) to see if they can be processed to work out of the box.

4. If that fails, try migrating to the [withUnistyles](/v3/references/with-unistyles) factory. It follows best practices and ensures that only a single component is re-rendered when dependencies change. It’s also recommended to map `react-native` properties like `color` or `trackColor`.

5. If that also fails, follow best practices and use the [useUnistyles](/v3/references/use-unistyles) hook.

# Breakpoints

> Learn about breakpoints in Unistyles 3.0

Breakpoints are user-defined key/value pairs that describe the boundaries of screen sizes. There’s no limit to the number of breakpoints; you can define as many as you want.

### Register breakpoints

To register your breakpoints, create an object with **any** keys:

unistyles.ts

```tsx
const breakpoints = {
    xs: 0,
    sm: 576,
    md: 768,
    lg: 992,
    xl: 1200,
    superLarge: 2000,
    tvLike: 4000
} as const
```

The first breakpoint **must** start with `0`. This is required to simulate CSS cascading, e.g., everything below 576px (`sm` breakpoint) will resolve to `xs` breakpoint.

If you use TypeScript you need to override the library’s type:

```tsx
type AppBreakpoints = typeof breakpoints


declare module 'react-native-unistyles' {
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}
```

Finally, to register the breakpoints, call `StyleSheet.configure`:

```tsx
import { UnistylesRegistry } from 'react-native-unistyles'


StyleSheet.configure({
    breakpoints
})
```

To learn more, follow the configuration [guide](/v3/start/configuration).

### How to use breakpoints?

Any style can change based on breakpoints. To do this, change a `value` to an `object`:

```tsx
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.background,
        backgroundColor: {
            // your breakpoints
            xs: theme.colors.background,
            sm: theme.colors.barbie
        }
    },
    text: {
        color: theme.colors.typography
    }
}))
```

You can even use it with nested objects like `transform`, `shadowOffset`, or `filters`:

```ts
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: {
            xs: theme.colors.background,
            sm: theme.colors.barbie
        },
        transform: [
            {
                translateX: 100
            },
            {
                scale: {
                    xs: 1.5,
                    xl: 0.9
                }
            }
        ]
    }
}))
```

Breakpoints are also available with [variants](/v3/references/variants/) and [compound variants](/v3/references/compound-variants/).

### Built-in breakpoints `landscape` and `portrait`

Even if you don’t use custom breakpoints, you can still utilize Unistyles’ predefined breakpoints available on mobile devices: `portrait` and `landscape`.

* `portrait` will resolve to your device’s width in portrait mode
* `landscape` will resolve to your device’s width in landscape mode

Tip

These breakpoints are only available on mobile unless you register your own.

```ts
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: {
            landscape: theme.colors.background,
            portrait: theme.colors.barbie
        }
    }
}))
```

### Pixel/Point mode for native breakpoints

By default, Unistyles will use `pixels` for native breakpoints. This means that the breakpoints and [mq](/v3/references/media-queries) will be computed based on mobile screen pixels. You can change this behavior by setting `nativeBreakpointsMode` to `points` in your [configuration](/v3/start/configuration#settings-optional).

If `nativeBreakpointsMode` is set to `points`, all breakpoints and `mq` will be computed based on mobile screen points (screen in pixels divided by pixel ratio).

### Show/Hide your components based on breakpoints

In order to show or hide your components based on the screen size, you can leverage the `mq` utility and one of the two built-in components: `Display` and `Hide`.

```tsx
import { Display, Hide, mq } from 'react-native-unistyles'


const MyComponent = () => {
    return (
        <Display mq={mq.only.width(0, 400)}>
            <Text>This text is visible on small devices</Text>
        </Display>
        <Hide mq={mq.only.width(400)}>
            <Text>This text is hidden on big devices</Text>
        </Hide>
    )
}
```

You can also access your current breakpoint with `UnistylesRuntime`:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// check the current breakpoint
export const CurrentBreakpoint = () => (
    <Text>
        Current breakpoint is {UnistylesRuntime.breakpoint}
    </Text>
)
```

### Get registered breakpoints

Access your registered breakpoints object with `UnistylesRuntime`:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// check the registered breakpoints
export const RegisteredBreakpoints = () => (
    <Text>
        My registered breakpoint are {JSON.stringify(UnistylesRuntime.breakpoints)}
    </Text>
)
```

# Compound Variants

> Learn about compound variants in Unistyles 3.0

You can extend your `StyleSheets` even further by using `compound variants`.

Compound variants are a way of applying additional styles when certain conditions are met. This approach simplifies the management of complex styling by reducing redundancy and increasing the flexibility of your `StyleSheets`.

### Basic usage

Let’s say you created a base `Typography` component with the following variants:

```tsx
const styles = StyleSheet.create(theme => ({
    baseText: {
        fontFamily: theme.fonts.base,
        fontWeight: 'normal'
    },
    themedText: {
        variants: {
            size: {
                small: {
                    fontSize: 12
                },
                medium: {
                    fontSize: 16
                },
                large: {
                    fontSize: 20
                }
            },
            isBold: {
                true: {
                    fontWeight: 'bold'
                }
            },
            color: {
                primary: {
                    color: theme.colors.primary
                },
                secondary: {
                    color: theme.colors.secondary
                },
                link: {
                    color: theme.colors.link
                }
            }
        }
    }
}
```

What if you’ve received a new requirement where the text should be underlined when `isBold` is `true` and `color` is `link`? This task could be challenging while using features like [dynamic functions](/v3/references/dynamic-functions/) as you would need to use `if` statements in your `StyleSheet`.

### Usage with Compound variants

With compound variants, it can be achieved in a more concise way:

```tsx
const styles = StyleSheet.create(theme => ({
    baseText: {
        fontFamily: theme.fonts.base,
        fontWeight: 'normal'
    },
    themedText: {
        variants: {
            size: {
                small: {
                    fontSize: 12
                },
                medium: {
                    fontSize: 16
                },
                large: {
                    fontSize: 20
                }
            },
            isBold: {
                true: {
                    fontWeight: 'bold'
                }
            },
            color: {
                primary: {
                    color: theme.colors.primary
                },
                secondary: {
                    color: theme.colors.secondary
                },
                link: {
                    color: theme.colors.link
                }
            }
        },
        compoundVariants: [
            {
                isBold: true, // when isBold is true
                color: 'link', // and color is link
                // apply following styles
                styles: {
                    textDecorationLine: 'underline'
                    // and more styles
                }
            }
        ]
    }
}
```

Styles from the `compoundVariants` array will take precedence over the styles defined in the `variants` object. You can define multiple `compoundVariants` in the array to handle different combinations of style properties. This allows for more granular control and customization of your component’s appearance.

# Content size category

> Learn about content size category in Unistyles 3.0

Content size category is a user preference used to adjust text size and control content magnification in your app. This feature is especially useful for users with visual impairments or limited vision.

It’s also possible to use these values to build responsive layouts based on native settings rather than screen size.

### iOS

Unistyles’ implementation is based on [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/typography#Specifications) and the available values are:

`xSmall`, `Small`, `Medium`, `Large`, `xLarge`, `xxLarge`, `xxxLarge`, `unspecified`

In addition to the above categories, you can also use the [Accessibility sizes](https://developer.apple.com/documentation/uikit/uicontentsizecategory#2901207), and the available values are:

`accessibilityMedium`, `accessibilityLarge`, `accessibilityExtraLarge`, `accessibilityExtraExtraLarge`, `accessibilityExtraExtraExtraLarge`

### Android

There is no direct equivalent to the iOS content size category on Android. The implementation is based on [Font Scale](https://developer.android.com/reference/android/content/res/Configuration#fontScale), and the available values are:

`Small`, `Default`, `Large`, `ExtraLarge`, `Huge`

Mapping is based on the following table:

| Value          | Font Scale |
| -------------- | ---------- |
| Small          | <= 0.85    |
| Default        | <= 1.0     |
| Large          | <= 1.15    |
| ExtraLarge     | <= 1.3     |
| Huge           | <=1.5      |
| ExtraHuge      | <=1.8      |
| ExtraExtraHuge | >1.8       |

### Web

There is no support for the content size category on the web. Reading the value will always resolve to `unspecified`.

### Usage

To get the current `contentSizeCategory`, you need to use `UnistylesRuntime`:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


// check the current content size category
export const ContentSizeCategory = () => (
    <Text>
        My device is using the {UnistylesRuntime.contentSizeCategory} size.
    </Text>
)
```

For convenience, the library exposes two enums to map the values mentioned above:

```tsx
import { AndroidContentSizeCategory, IOSContentSizeCategory } from 'react-native-unistyles'


// compare the current content size category based on platform
```

# Dimensions

> Learn about Dimensions in Unistyles 3.0

Unistyles provides rich metadata about your device dimensions. This is useful for creating responsive designs as well as avoiding installing third-party libraries. Every property listed below can be accessed with [UnistylesRuntime](/v3/references/unistyles-runtime). Dimensions are always up to date and are updated based on Unistyles’ core logic, e.g., when the device orientation changes.

### Accessing dimensions

In order to start using the dimensions metadata, you need to import `UnistylesRuntime`:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'
```

### Screen dimensions

The most basic dimensions are the screen dimensions. These are the dimensions of the screen that your app is running on. You can access them with the `screen` prop:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


UnistylesRuntime.screen.width // eg. 400
UnistylesRuntime.screen.height // eg. 760
```

### Status bar

You can access status bar dimensions with the `statusBar` prop:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


UnistylesRuntime.statusBar.width // eg. 400
UnistylesRuntime.statusBar.height // eg. 24
```

This prop may be useful for creating custom headers. In most of the cases status bar height is equal to the top inset, but on some devices it may be different.

### Navigation bar

You can access navigation bar dimensions with `navigationBar` prop:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


UnistylesRuntime.navigationBar.width // eg. 400
UnistylesRuntime.navigationBar.height // eg. 24
```

This prop may be useful for creating custom bottom bars. In most of the cases navigation bar height is equal to the bottom inset, but on some devices it may be different.

### Insets

Insets are the safe areas of the screen. They are used to avoid overlapping with system UI elements such as the status bar, navigation bar, and home indicator. You can access them with `insets` prop:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'


UnistylesRuntime.insets.top // eg. 42
UnistylesRuntime.insets.bottom // eg. 24
UnistylesRuntime.insets.left // eg. 0, or in vertical orientation can be top inset
UnistylesRuntime.insets.right // eg. 0
UnistylesRuntime.insets.ime // eg. 0
```

Note

Read more about IME insets in keyboard [guide](/v3/guides/avoiding-keyboard/).

Insets can be used directly in your stylesheets to avoid passing values from `useSafeAreaInsets` hook from [react-native-safe-area-context](https://github.com/th3rdwave/react-native-safe-area-context?tab=readme-ov-file#usesafeareainsets) library.

Note

Unistyles uses `WindowsInsetsCompat` API to handle insets on Android. This API requires your app to have edge to edge layout enabled. Read more about it [here](/v3/references/edge-to-edge/).

Insets on Android respect following setups:

```tsx
<StatusBar />
<StatusBar hidden />
<StatusBar translucent /> // enabled by default
```

Unistyles automatically reacts when you hide or show status and navigation bars. Yo can do that with `UnistylesRuntime` [as well](/v3/references/unistyles-runtime/#setters).

### Pixel ratio

Device Pixel Ratio (DPR) is the ratio between physical pixels and device-independent pixels (DIPs) on a screen. It determines how many physical pixels are used to represent a single CSS pixel.

Most likely, your phone pixel ratio ranges between 1.0 to 3.0 (retina).

```tsx
UnistylesRuntime.pixelRatio // eg. 2.0
```

### Font scale

Font scale is a ratio between the font size of the device and the default font size. It is used to adjust the size of text on the screen in companion with [content size category](/v3/references/content-size-category/).

```tsx
UnistylesRuntime.fontScale // eg. 1.0
```

# Display and Hide components

> Learn about Display and Hide components

In Unistyles 2.0, developers could retrieve the `breakpoint` value from the `useStyles` hook. This was helpful for hiding certain JSX components based on specific screen sizes.

However, this pattern was a bit tedious, as it required writing custom logic to determine whether a component should be visible or not.

With Unistyles 3.0, preferred way of listening for breakpoint changes is with `Display` and `Hide` components.

### Display

The Display component helps you show its children based on `breakpoints` or `media queries`.

```tsx
import React from 'react'
import { View } from 'react-native'
import { Display, mq } from 'react-native-unistyles'


const Component = () => {
    return (
        <View style={styles.container}>
            <Display mq={mq.only.width('sm')}>
                <View style={styles.text}>
                    I will be visible from 'sm' breakpoint and up
                </View>
            </Display>
        </View>
    )
}
```

You can also use pixel-based values:

```tsx
import React from 'react'
import { View } from 'react-native'
import { Display, mq } from 'react-native-unistyles'


const Component = () => {
    return (
        <View style={styles.container}>
            <Display mq={mq.only.width(0, 500)}>
                <View style={styles.text}>
                    I will be visible from 0 to 500px
                </View>
            </Display>
        </View>
    )
}
```

### Hide

On the opposite side, the `Hide` component helps you hide its children based on `breakpoints` or `media queries`. It works exactly the same way as the Display component.

```tsx
import React from 'react'
import { View } from 'react-native'
import { Hide, mq } from 'react-native-unistyles'


const Component = () => {
    return (
        <View style={styles.container}>
            <Hide mq={mq.only.width('sm', 'lg')}>
                <View style={styles.text}>
                    I will be hidden from 'sm' breakpoint to 'lg' breakpoint
                </View>
            </Hide>
        </View>
    )
}
```

Caution

Does it mean that Unistyles introduced a new components?

Well, no! These components are simple if-else statements used to conditionally render your JSX. We won’t wrap your components in any additional layers.

We believe this saves you a lot of time and effort, eliminating the need to implement the logic yourself or causing re-renders by listening to any hooks.

# Dynamic Functions

> Learn about dynamic functions in Unistyles 3.0

If you need to pass a value from JSX to your `stylesheet` you can do so using a concept called `dynamic function`.

### Usage

To use a dynamic function, change **any** stylesheet’s value from an `object` to a `function`:

```tsx
const styles = StyleSheet.create(theme => ({
    container: {
    container: () => ({
        backgroundColor: theme.colors.background,
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
    }
    })
}))
```

Now, you can pass **any** number of arguments, and all with TypeScript hints:

```tsx
export const Example = ({ maxWidth, isOdd, children }) => {
    return (
        <View style={styles.container(maxWidth, isOdd)}>
            {children}
        </View>
    )
}


const styles = StyleSheet.create(theme => ({
    container: (maxWidth: number, isOdd: boolean) => ({
        backgroundColor: theme.colors.background,
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        maxWidth,
        borderBottomWidth: isOdd ? 1 : undefined
    })
}))
```

Serializable arguments

Keep in mind that a dynamic function can accept only serializable arguments. These arguments will be passed to C++, so anything that can be represented as `folly::dynamic` is supported (such as strings, numbers, booleans, arrays, objects, etc.).

# Edge to edge layout with Unistyles

> Learn how Unistyles leverages edge to edge layout

### iOS

Unistyles uses native `SafeAreaInsets` API to handle insets on iOS. This API is stable and works the same across all iOS versions.

Most likely, you’ll never receive incorrect inset values on iOS.

### Android

Unistyles uses `WindowsInsetsCompat` API to handle insets on Android. This API requires your app to have edge to edge layout enabled. In other words, it means that your `StatusBar` is always `translucent` and the app can draw behind the `NavigationBar`. A translucent status bar is also the default when you build your app with Expo. To leverage `WindowInsetsCompat`, Unistyles enables `edgeToEdge` layout by default.

As a result you need to use paddings to draw your app content above system bars. To learn more about `edgeToEdge` layout please check [Window insets in Compose](https://developer.android.com/develop/ui/compose/layouts/insets).

```tsx
import { StyleSheet } from 'react-native-unistyles'


const App = () => (
    <View style={styles.container}>
        <Text style={styles.text}>
            Correct insets
        </Text>
    </View>
)


const styles = StyleSheet.create((theme, rt) => ({
    container: {
        backgroundColor: theme.colors.background,
        flex: 1,
        // apply insets to the container,
        // so it will add required paddings
        paddingTop: rt.insets.top,
        paddingBottom: rt.insets.bottom,
        paddingLeft: rt.insets.left,
        paddingRight: rt.insets.right
    },
})
```

Edge-to-edge enforcement

Apps are edge-to-edge by default on devices running Android 15 if the app is targeting Android 15 (API level 35).

[Learn more](https://developer.android.com/about/versions/15/behavior-changes-15)

Caution

Unistyles enables `edgeToEdge` by default, but sometimes other libraries might interfere with it. We decided to depend on `react-native-edge-to-edge` package, to help reduce these issues. Learn more [here](/v3/other/dependencies#react-native-edge-to-edge).

# Media Queries

> Learn about media queries in Unistyles 3.0

Media queries provide more power and allow you to style cross-platform apps with pixel-perfect accuracy.

### Basic usage

To use media queries, you need to import the `mq` utility and convert your value to an `object`:

```tsx
import { Stylesheet, mq } from 'react-native-unistyles'


const styles = Stylesheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
        backgroundColor: theme.colors.background,
        backgroundColor: {
            [mq.only.width(240, 380)]: theme.colors.background,
            [mq.only.width(380)]: theme.colors.barbie
       }
    }
}))
```

The `mq` utility provides Intellisense for quickly building your media queries.

### Advanced usage

You can also combine `width` media queries with `height` media queries:

```tsx
import { StyleSheet, mq } from 'react-native-unistyles'


const styles = Stylesheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
        backgroundColor: theme.colors.background,
        backgroundColor: {
            [mq.width(240, 380).and.height(300)]: theme.colors.background,
            [mq.width(380).and.height(300)]: theme.colors.barbie
        }
    }
}))
```

Or use only `height` media queries:

```tsx
import { StyleSheet, mq } from 'react-native-unistyles'


const styles = Stylesheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
        backgroundColor: theme.colors.background,
        backgroundColor: {
            [mq.only.height(300, 500)]: theme.colors.background,
            [mq.only.height(500)]: theme.colors.barbie
        }
    }
}))
```

You can also reuse your defined [breakpoints](/v3/references/breakpoints/):

```tsx
import { StyleSheet, mq } from 'react-native-unistyles'


const styles = Stylesheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
        backgroundColor: theme.colors.background,
        backgroundColor: {
            [mq.only.height(500)]: theme.colors.background,
            [mq.only.width(200, 'xl')]: theme.colors.barbie
        }
    }
}))
```

### Reference

Available combinations

```shell
mq.only.width // target only width
mq.only.height // target only height
mq.width(...).and.height(...) // target both width and height
mq.height(...).and.width(...) // target both height and width
```

Available values

```shell
(100, 200) // from 100 to 199
(400, 'xl') // from 400 to 'xl' breakpoint
('sm', 'md') // from 'sm' to 'md' breakpoint
(undefined, 1000) // from 0 to 999
(null, 800) // from 0 to 799
(500) // from 500 onwards
```

Full example

```shell
mq.only.width(100, 200) // width from 100 to 199
mq.height(500).and.width('sm') // heigh from 500 onwards and width from 'sm' breakpoint onwards
mq.only.height(null, 1000) // height from 0 to 999
```

Tip

If you pass an invalid range to mq utility eg. (‘xl’, ‘sm’) or (500, 200) the media query will be marked as invalid and won’t be used to resolve your styles.

### Combining media queries with breakpoints

You can mix media queries with breakpoints, but media queries will always have higher priority:

```tsx
import { StyleSheet, mq} from 'react-native-unistyles'


const styles = Stylesheet.create(theme => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
        backgroundColor: {
            sm: theme.colors.background,
            // Unistyles will firsly resolve to this style, even though 'sm' breakpoint may be also correct
            [mq.only.width(200, 'xl')]: theme.colors.barbie
        }
    }
}))
```

### CSS Media Queries

`Breakpoints` and `Media Queries` will be auto converted to Web CSS media queries. Learn more about [Web Media Queries](/v3/references/web-styles#how-it-works).

# Mini Runtime

> Learn about mini runtime in Unistyles 3.0

Mini runtime was introduced in Unistyles `2.8.0` as a subset of `UnistylesRuntime` containing only the properties that are useful in your `StyleSheet`.

It doesn’t include any functions, as they aren’t necessary when you’re referencing your platform values.

Mini runtime returns following object:

```tsx
type MiniRuntime = {
    readonly themeName?: string, // eg. light or undefined if you haven't registered any themes
    readonly breakpoint?: string, // eg. sm or undefined if you haven't registered any breakpoints
    readonly hasAdaptiveThemes: boolean, //  true if you have enabled adaptive themes
    readonly colorScheme: ColorScheme, // eg. light or dark or unspecified
    readonly screen: Dimensions, // eg. {width: 1024, height: 768}
    readonly contentSizeCategory: string, // eg. Large
    readonly insets: Insets, // eg. { top: 28, bottom: 40, left: 0, right: 0 , ime: 0 }
    readonly pixelRatio: number, // eg. 3.0
    readonly fontScale: number, // eg. 1.5
    readonly rtl: boolean // true if your user prefers RTL
    readonly statusBar: Dimensions, // eg. { width: 240, height: 20,  }
    readonly navigationBar: Dimensions // eg. { width: 240, height: 44,  }
    readonly isPortrait: boolean, // true if your device is in portrait mode
    readonly isLandscape: boolean // true if your device is in landscape mode
}
```

Mini runtime is automatically injected when Unistyles resolves a `StyleSheet` that depends on it.

# Scoped Theme

> Learn about scoped theme in Unistyles 3.0

There are cases where you may want to render specific components or screens with a fixed theme. For instance, a `Camera` view might require a dark background for better contrast, even if the user has selected light mode for the app. Other examples include modals, dialogs, or enabling users to preview the app in different themes to choose their preferred one.

To address this, Unistyles 3.0 introduces the concept of a `Scoped Theme`, which allows you to assign a fixed theme to a specific component or screen.

### Usage with named theme

To use scoped theme, you need to import `ScopedTheme` component from `react-native-unistyles`:

```ts
import { ScopedTheme } from 'react-native-unistyles'
```

Scoped theme accepts one of your registered theme names as a prop:

```tsx
<ScopedTheme name="dark">
    // components here will be fixed to dark theme
    <View style={styles.container}>
        <Text style={styles.text}>
            Hello world
        </Text>
    </View>
</ScopedTheme>
```

You can also nest `ScopedTheme` components:

```tsx
<ScopedTheme name="dark">
    // I will be dark!
    <View style={styles.container}>
        <Text style={styles.text}>
            Dark
        </Text>
    </View>
    <ScopedTheme name="light">
        // I will be light!
        <View style={styles.container}>
            <Text style={styles.text}>
                Light
            </Text>
        </View>
    </ScopedTheme>
    // I will be dark again!
    <View style={styles.container}>
        <Text style={styles.text}>
            Dark
        </Text>
    </View>
</ScopedTheme>
```

### Usage with inverted adaptive theme

You can also use `ScopedTheme` with the `invertedAdaptive` prop. This prop cannot be used together with a named `ScopedTheme`, as these options are mutually exclusive. The purpose of `invertedAdaptive` is to apply the opposite adaptive theme to the one that is currently active.

In other words, if your app supports [adaptive themes](/v3/guides/theming#adaptive-themes) and you use `ScopedTheme` with the `invertedAdaptive` prop, it will apply:

```plaintext
the dark theme when the color scheme is light
the light theme when the color scheme is dark
```

**Use Cases**:

The `invertedAdaptive` prop is useful in scenarios where you want to highlight a specific section of your app by contrasting it with the current theme. For example:

* **Modal dialogs or popups:** Make a modal stand out by using the opposite theme, drawing the user’s attention
* **Preview components:** Show users how your app looks in both light and dark modes by inverting the theme for a preview section
* **Special content areas:** Emphasize warnings, tips, or promotional banners by displaying them with a contrasting theme

By using `invertedAdaptive`, you can create visually distinct areas in your app that improve user experience and accessibility.

```tsx
<ScopedTheme invertedAdaptive>
    <View style={styles.container}>
        <Text style={styles.text}>
            Text is light when color scheme is dark and dark when color scheme is light
        </Text>
    </View>
</ScopedTheme>
```

You can also nest other `ScopedThemes` inside `ScopedTheme` with `invertedAdaptive` prop.

### Reset

If you wrap multiple children in `ScopedTheme` you can disable scoped theme for some of them by using `reset` prop:

```tsx
<ScopedTheme name="dark">
    <View style={styles.container}>
        <Text style={styles.text}>
            I will be dark!
        </Text>
    </View>
    <ScopedTheme reset>
        <View style={styles.container}>
            <Text style={styles.text}>
                I will be light again!
            </Text>
        </View>
    </ScopedTheme>
    <View style={styles.container}>
        <Text style={styles.text}>
            I'm dark again
        </Text>
    </View>
</ScopedTheme>
```

### Reading current scoped theme

Information about the current `ScopedTheme` is temporary and only available during the component render phase.

For the following example, `themeName` will be different based on the place where we access it:

```tsx
import { UnistylesRuntime, ScopedTheme } from 'react-native-unistyles'


const MyComponent = () => {
    // themeName will be 'light' here 💥
    const themeName = UnistylesRuntime.themeName


    return (
        <ScopedTheme name="dark">
            <ScopedText>
                I'm scoped
            </ScopedText>
        </ScopedTheme>
    )
}


const ScopedText = ({ children }) => {
    // themeName will be 'dark' here ✅
    // because we're "inside" of the ScopedTheme
    const themeName = UnistylesRuntime.themeName


    return (
        <Text style={styles.text}>
            {children}
        </Text>
    )
}
```

If you want to react to changes in the scoped theme, you can use the `useUnistyles` hook or the `withUnistyles` helper:

```tsx
import { useUnistyles, ScopedTheme } from 'react-native-unistyles'


// My parent is wrapped with ScopedTheme invertedAdaptive
const ScopedComponent = () => {
    // reading themeName from `useUnistyles` will always log
    // correctly parent scoped theme name 🤯
    const { rt } = useUnistyles()


    return (
        <Text>
            {rt.themeName} // light for dark mode, dark for light mode
        </Text>
    )
}


// JSX
<ScopedTheme invertedAdaptive>
    <ScopedComponent />
</ScopedTheme>
```

Same goes for the `withUnistyles` helper:

```tsx
import { withUnistyles, ScopedTheme } from 'react-native-unistyles'


const ScopedTextInput = withUnistyles(TextInput, (theme, rt) => ({
    // I will always take in count parent scoped theme
    color: rt.themeName === 'light'
        ? theme.colors.text
        : theme.colors.background
}))


// My parent is wrapped with ScopedTheme invertedAdaptive
const ScopedComponent = () => {
    return (
        <ScopedTextInput />
    )
}


// JSX
<ScopedTheme invertedAdaptive>
    <ScopedComponent />
</ScopedTheme>
```

### Scoped Theme with Suspense

When using `ScopedTheme` with React’s `Suspense`, there’s an important consideration about component placement due to how React handles suspension and re-rendering.

React Suspense works by catching promises thrown by child components that are waiting for data. When this happens:

1. React pauses rendering and shows the fallback content
2. Components that successfully rendered before the suspension may be reused
3. Parent components might not re-render when the suspended data becomes available

This means if you place `ScopedTheme` above a component that suspends, the scoped theme might not be applied correctly when the component finally renders:

```tsx
// ❌ This won't work correctly
<Suspense fallback={<Loading />}>
    <ScopedTheme name="dark">
        <SuspendedComponent /> {/* ScopedTheme already rendered before suspension */}
    </ScopedTheme>
</Suspense>
```

Unistyles ScopedTheme is only available during render phase, we decided to not use `React.Context` to keep the API performant and easy to use.

To fix this issue, you can move the `ScopedTheme` inside the suspended component:

```tsx
// ✅ Place ScopedTheme inside the component that suspends
const SuspendedComponent = () => {
    const data = useSuspenseQuery(); // This throws a promise


    return (
        <ScopedTheme name="dark">
            <View style={styles.container}>
                <Text style={styles.text}>
                    {data.title}
                </Text>
            </View>
        </ScopedTheme>
    );
};


<Suspense fallback={<Loading />}>
    <SuspendedComponent />
</Suspense>
```

The key is to ensure that `ScopedTheme` is rendered **after** the suspension occurs, so that when React re-renders the suspended component tree, the scoped theme context is properly established.

This pattern ensures that your themed components will render with the correct theme once the suspended data becomes available.

### Scoped Theme and Hot Module Reloading (HMR)

When working with `ScopedTheme` in development, you might notice that Hot Module Reloading doesn’t always update the theme when you make changes to child components. This is a limitation of Metro’s Fast Refresh system.

Unlike Webpack, Metro’s Fast Refresh only re-runs code in the file you’re actively editing and its direct imports. It doesn’t have a global event system that can notify parent components when child modules change.

Metro provides these HMR functions:

```tsx
module.hot.accept(fn)   // fires if *this* module is updated
module.hot.dispose(fn)  // fires just before *this* module is replaced
```

However, **neither of these runs** when other modules change. This means that changes in child components won’t trigger a re-render of their parent `ScopedTheme`:

```tsx
<ScopedTheme name="light">
    <ChildComponent /> {/* Changes in this file won't trigger ScopedTheme to update */}
</ScopedTheme>
```

#### Why We Don’t Use React Context

The “ideal” solution would be to use React Context for theme propagation, which would work seamlessly with HMR. However, we’ve chosen performance over convenience. Using React Context would introduce additional re-renders and overhead that could impact your app’s performance, especially in complex component trees.

We prioritize keeping the API fast and lightweight, even if it means accepting some development-time limitations with HMR.

# StyleSheet

> Learn about StyleSheet in Unistyles 3.0

`StyleSheet` replaces the old `createStyleSheet` function and aims for 1:1 parity with the React Native API. When we say that Unistyles is a superset of StyleSheet, we mean it! That’s why we are taking it one step further!

### create

The `create` function supports all styles that React Native’s StyleSheet does, and it also enables some superpowers 🦸🏼‍♂️. It can parse your `variants`, `compoundVariants` or `dynamic functions` (even if you haven’t configured Unistyles yet!).

Once you register your `themes` and `breakpoints`, it unlocks even more features, like injecting the current `theme` or `miniRuntime` into your stylesheet. It also assists you with TypeScript autocompletion for your styles.

Example usage:

```tsx
import { StyleSheet } from 'react-native-unistyles'


const styles = StyleSheet.create((theme, rt) => ({
    container: {
        backgroundColor: theme.colors.background,
        variants: {
            size: {
                small: {
                    width: 100,
                    height: 100
                },
                medium: {
                    width: 200,
                    height: 200
                },
                large: {
                    width: 300,
                    height: 300
                }
            },
            isPrimary: {
                true: {
                    color: theme.colors.primary
                },
                default: {
                    color: theme.colors.secondary
                },
                special: {
                    color: theme.colors.special
                }
            }
        }
    },
    text: {
        fontSize: rt.fontScale * 20,
        color: {
            sm: theme.colors.text,
            md: theme.colors.textSecondary
        }
    })
}))
```

Will be eg. parsed to:

```ts
{
    container: {
        backgroundColor: '#000',
        width: 200,
        height: 200,
        color: '#ff33aa'
    },
    text: {
        fontSize: 32,
        color: 'gold'
    }
}
```

Unistyles StyleSheet will automatically react and recalculate your styles if any of your dependencies change. Learn more about it [here](/v3/start/how-unistyles-works).

`StyleSheet.create` supports 3 ways of defining your stylesheets:

#### Static StyleSheet

```tsx
import { StyleSheet } from 'react-native-unistyles'


const styles = StyleSheet.create({
    container: {
        backgroundColor: 'red'
    }
})
```

#### Themable StyleSheet

```tsx
import { StyleSheet } from 'react-native-unistyles'


const styles = StyleSheet.create(theme => ({
    container: {
        backgroundColor: theme.colors.background
    }
}))
```

#### Themable StyleSheet with `miniRuntime`

```tsx
import { StyleSheet } from 'react-native-unistyles'


const styles = StyleSheet.create((theme, rt) => ({
    container: {
        backgroundColor: theme.colors.background,
        paddingTop: rt.insets.top
    }
}))
```

Learn more about `miniRuntime` [here](/v3/references/mini-runtime/).

### configure

`StyleSheet.configure` is used to configure Unistyles. It accepts an object with the following properties:

* `themes` your apps themes
* `breakpoints` your apps breakpoints
* `settings` additional settings

Your themes are scoped across the whole app, unless your limit it with a [scoped themes](/v3/references/scoped-theme/).

The `configure` function **must** be called before you import any component that uses Unistyles StyleSheet.

You can learn more about how to configure Unistyles [here](/v3/start/configuration).

### hairlineWidth

`StyleSheet.hairlineWidth` is a static value representing the smallest value that can be drawn on your device. It’s helpful for borders or dividers.

```tsx
import { StyleSheet } from 'react-native-unistyles'


const styles = StyleSheet.create(theme => ({
    container: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.accent
    }
}))
```

### compose

Maps to React Native’s [compose function](https://reactnative.dev/docs/stylesheet#compose).

### flatten

Maps to React Native’s [flatten function](https://reactnative.dev/docs/stylesheet#flatten).

### absoluteFillObject

Returns following object:

```ts
{
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0
}
```

### absoluteFill

Returns following object:

```ts
{
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0
}
```

# Unistyles Runtime

> Learn about Unistyles Runtime in Unistyles 3.0

Unistyles Runtime is a powerful feature that allows you to access platform specific values directly from `JavaScript`. It allows you to skip many dependencies and keep a lot of functionality under one object.

### Usage

You can import `UnistylesRuntime` from `react-native-unistyles`:

```tsx
import { UnistylesRuntime } from 'react-native-unistyles'
```

and use it anywhere in your code, even outside a React component.

### Available getters

| Name                | Type                                                                      | Description                                                                         |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| colorScheme         | string                                                                    | Get your device’s color scheme. Available options `dark`, `light` or `unspecified`  |
| hasAdaptiveThemes   | boolean                                                                   | Indicates if you have enabled [adaptive themes](/v3/guides/theming#adaptive-themes) |
| themeName           | string?                                                                   | Name of the selected theme or `undefined` if you haven’t register any theme         |
| breakpoint          | string?                                                                   | Current breakpoint or undefined if you haven’t registered any                       |
| breakpoints         | Object                                                                    | Your registered breakpoints                                                         |
| screen              | {width: number, height: number}                                           | Screen dimensions                                                                   |
| isPortrait          | boolean                                                                   | Indicates if your device is in portrait mode                                        |
| isLandscape         | boolean                                                                   | Indicates if your device is in landscape mode                                       |
| contentSizeCategory | IOSContentSizeCategory or AndroidContentSizeCategory                      | Your device’s [content size category](/v3/references/content-size-category/)        |
| insets              | { top: number, bottom: number, left: number, right: number, ime: number } | Device insets which are safe to put content into                                    |
| statusBar           | {width: number, height: number}                                           | Status bar dimensions                                                               |
| navigationBar       | {width: number, height: number}                                           | Navigation bar dimensions (Android only)                                            |
| pixelRatio          | number                                                                    | Pixel density of the device                                                         |
| fontScale           | number                                                                    | Font scale of the device                                                            |
| rtl                 | boolean                                                                   | Indicates if the device is in RTL mode                                              |
| getTheme            | (themeName?: string) => Theme                                             | Get theme by name or current theme if name was not specified                        |

## Setters

| Name                       | Type                                                                 | Description                                                                    |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| setTheme                   | (themeName: string) => void                                          | Change the current theme                                                       |
| setAdaptiveThemes          | (enabled: boolean) => void                                           | Toggle [adaptive themes](/v3/guides/theming#adaptive-themes)                   |
| updateTheme                | (themeName: string, updater: (currentTheme: Theme) => Theme) => void | Update the [theme](/v3/guides/theming/#update-theme-during-runtime) at runtime |
| statusBar.setHidden        | (hidden: boolean) => void                                            | Show/hide status bar at runtime                                                |
| navigationBar.setHidden    | (hidden: boolean) => void                                            | Show/hide navigation bar at runtime                                            |
| setImmersiveMode           | (enabled: boolean) => void                                           | Enable/disable immersive mode (hiding both status and navigation bars)         |
| setRootViewBackgroundColor | (color: string) => void                                              | set root view background color                                                 |

### Why `UnistylesRuntime` doesn’t re-render my component?

You should think of `UnistylesRuntime` as a JavaScript object. It’s not a React hook, so it doesn’t re-render your component when eg. screen size or breakpoint changes. Instead it will return up to date value whenever you access it.

If you’re looking for a way to get fresh values and re-render your component, please check [useUnistyles](/v3/references/use-unistyles) hook.

### How to re-render my stylesheets based on `UnistylesRuntime`?

You can do that while accessing [miniRuntime](/v3/references/mini-runtime/) in your `StyleSheet`:

One example could be reading device width and height:

```tsx
import { StyleSheet } from 'react-native-unistyles'


// your component


const style = StyleSheet.create((theme, rt) => ({
    container: {
        backgroundColor: theme.colors.background,
        width: rt.screen.width,
        height: rt.screen.height
    }
}))
```

Your `container` style will be auto-recalculated when `screen` changes.

Learn more on how Unistyles [recalculates your styles](/v3/start/how-unistyles-works).

# useUnistyles

> Learn about escape hatch in Unistyles 3.0

Unistyles provides a way to access your app’s theme and runtime within your components through a hook.

Caution

We strongly recommend **not using** this hook, as it will re-render your component on every change. This hook was created to simplify the migration process and should only be used when other methods fail.

Follow our [decision algorithm](/v3/references/3rd-party-views) to learn when to use this hook.

### When to use it?

If you’re using `react-native`, or `react-native-reanimated` components, you should avoid this hook. Unistyles updates these views via the ShadowTree without causing **any re-renders**.

Consider using this hook only if:

* You need to update a view in a third-party library like `react-native-blurhash`
* You’ve already tried using [withUnistyles](/v3/references/with-unistyles) without success
* You want to style [navigation](https://reactnavigation.org/) props as `react-navigation` is optimized for that and never re-render your screens
* some libraries like `react-navigation` warns you that only specific children are allowed, so `withUnistyles` is not an option

### How to use it?

This is a standard hook that exposes `theme` and `rt` ([runtime](/v3/references/mini-runtime)) properties. You can import it from `react-native-unistyles`:

```tsx
import { useUnistyles } from 'react-native-unistyles'


const MyComponent = () => {
    const { theme, rt } = useUnistyles()


    return (
        // your view
    )
}
```

Subscriptions

Unistyles will monitor your destructured props and re-render your component only when the desired value changes. If you use `theme`, it will automatically subscribe to theme changes. Destructuring `rt` won’t create an automatic subscription, as this object contains multiple values that can change frequently during your app’s lifecycle. To create a subscription, you need to use a specific property on the `rt` object, such as `rt.colorScheme` or `rt.screen.width`.

Case 1 - theme only subscription

```tsx
// subscribes to theme changes, rt is not yet used
const { theme, rt } = useUnistyles()
```

vs

Case 2 - theme and insets subscription

```tsx
// subscribes to theme changes
const { theme, rt } = useUnistyles()


rt.insets // reading this value will automatically subscribe to insets changes
```

### Why isn’t it recommended?

We encourage using `withUnistyles` instead because it ensures only a single component is re-rendered instead of multiple components or the entire app. If you use this hook in a root component, you lose all the benefits of ShadowTree updates and trigger full app re-renders on every change.

Learn more about [How Unistyles works?](/v3/start/how-unistyles-works) to understand why this is not ideal.

Another advantage of `withUnistyles` is that it tracks style dependencies, ensuring only components with changed dependencies are re-rendered. In contrast, `useUnistyles` will re-render the component whenever `theme` or `rt` properties change. Note that `runtime` contains multiple values that can change frequently during your app’s lifecycle.

### How to use it correctly?

If you must use this hook, follow these best practices:

#### 1. Use it only for a single component

```tsx
import { useUnistyles } from 'react-native-unistyles'
import Icon from 'react-native-cool-icons/MaterialIcons'


const MyComponent = () => {
    const { theme } = useUnistyles()


    // Ensure this component has no children
    return (
        <Icon color={theme.colors.primary} />
    )
}
```

Like `withUnistyles`, create a new component and use the hook there. Avoid using this hook in your root component or screen, as it will cause unnecessary re-renders for other components.

#### 2. Use it with `react-navigation` components like `Stack` or `Tabs`

```tsx
import { Stack } from 'expo-router'


export default function Layout() {
    const { theme } = useUnistyles()


    return (
        <Stack
            screenOptions={{
                headerStyle: {
                    backgroundColor: theme.colors.background
                }
            }}
        >
            <Stack.Screen name="home" />
        </Stack>
    )
}
```

This is allowed because `react-navigation` does not re-render screens on style prop change. Note that using `withUnistyles` instead may generate a warning since `Stack` components won’t allow other external components.

#### 3. Migration from Unistyles 2.0

If you’re migrating from version 2.0 to 3.0, you can use `useUnistyles` to access the theme and runtime in your components. This works similarly to the `useStyles` hook in 2.0. Once migration is complete, refactor your code to align with Unistyles 3.0 principles.

### Bad Practices

#### 1. Using it with complex components:

```tsx
import { useUnistyles } from 'react-native-unistyles'
import { Blurhash } from 'react-native-blurhash'


const MyComponent = () => {
    const { theme } = useUnistyles()


    return (
        <View>
            <Component1 />
            <Component2 />
            <ComponentN />
            <Blurhash
                blurhash="LGFFaXYk^6#M@-5c,1J5@[or[Q6."
                style={{
                    backgroundColor: theme.colors.primary
                }}
            />
        </View>
    )
}
```

This will re-render multiple components unnecessarily. Instead move `Blurhash` to a separate component and use `useUnistyles` there.

#### 2. Using it at the root level:

```tsx
import { useUnistyles } from 'react-native-unistyles'


const MyApp = () => {
    const { theme } = useUnistyles()


    return (
        <View>
            <App />
        </View>
    )
}
```

Using the hook at the root level eliminates all Unistyles benefits, causing your app to re-render unnecessarily.

#### 3. Using it with `react-native` components:

```tsx
import { useUnistyles } from 'react-native-unistyles'
import { Text } from 'react-native'


const MyComponent = () => {
    const { theme } = useUnistyles()


    return (
        <Text style={{ color: theme.colors.primary }}>
            Hello world
        </Text>
    )
}
```

This is a bad practice. Unistyles updates `react-native` components through the ShadowTree without re-rendering. Using this hook here will cause unnecessary re-renders. Once again follow our [decision algorithm](/v3/references/3rd-party-views) to learn about another options.

# Variants

> Learn about variants in Unistyles 3.0

Variants helps you to create a more flexible and reusable stylesheet eg. for your base components. You can mix them with other Unistyles features like [media queries](/v3/references/media-queries/) and [breakpoints](/v3/references/breakpoints/).

### Basic usage

Variants are objects that can be nested in any style object:

```tsx
const styles = StyleSheet.create(theme => ({
    container: {
        backgroundColor: theme.colors.background,
        variants: {
            // here you can define your variants
        }
    },
    text: {
        color: theme.colors.text,
        variants: {
            // here you can define other variants!
        }
    }
}))
```

Variants contain `groups` of atomic variants.

To define a group, first you need to name it and then define variants within it:

```tsx
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        variants: {
            color: {},
            size: {},
            otherGroupName: {}
        }
    }
}
```

These groups will later be used to select your variants, so remember to name them appropriately.

With the given structure, you can now define your variants that can contain any number of styles. You can also use `breakpoints`, `media queries` or styles like `transform`:

```tsx
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        variants: {
            color: {
                primary: {
                    backgroundColor: theme.colors.primary
                },
                secondary: {
                    backgroundColor: theme.colors.secondary
                }
            },
            size: {
                small: {
                    width: 100,
                    height: 100
                },
                medium: {
                    width: 200,
                    height: 200
                },
                large: {
                    width: 300,
                    height: 300
                }
            },
            otherGroupName: {
                // other variants
            }
        }
    }
}
```

### Selecting variants

With your named groups, you can now select any variant from your stylesheet using the `useVariants`:

```tsx
import { StyleSheet } from 'react-native-unistyles'


const Component = () => {
    styles.useVariants({
        color: 'primary',
        size: 'small'
    })


    return (
        <View style={styles.container} />
    )
}


const styles = ...
```

TypeScript will provide perfect autocompletion for your variants, ensuring accuracy!

### Selecting variants with boolean values

You can also use boolean values to select variants:

```tsx
import { StyleSheet } from 'react-native-unistyles'


const Component = ({ isPrimary, isDisabled }) => {
    styles.useVariants({
        color: !isDisabled,
        borderColor: isPrimary
        // you can also use strings
        // color: "true" | "false"
    })


    return (
        <View style={styles.container} />
    )
}


const styles = StyleSheet.create(theme => ({
    container: {
        // other styles
        variants: {
            color: {
                true: {
                    backgroundColor: theme.colors.primary
                },
                false: {
                    backgroundColor: theme.colors.disabled
                },
                // you can still specify a default variant
                default: {
                    backgroundColor: theme.colors.barbie
                }
                // or other variants
                special: {
                    backgroundColor: theme.colors.special
                }
            },
            borderColor: {
                true: {
                    borderColor: theme.colors.primary
                }
                // you can also skip "false" here
            }
        }
    }
})
```

If you specify a boolean variants like “true”, there is no requirement to specify a “false” variant (and vice versa). You can mix boolean variants with other variants as well.

Caution

Boolean variants respects other rules, eg. `false` is not equal to `default`. To select `false` variant you need to pass `false` as a value, to fallback to `default` variant you need to pass `undefined`.

### Default variant

You can define a `default` variant that will be used when you don’t pass any variant to the `useVariants` hook:

```tsx
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        variants: {
            color: {
                primary: {
                    backgroundColor: theme.colors.primary
                },
                secondary: {
                    backgroundColor: theme.colors.secondary
                },
                default: {
                    backgroundColor: theme.colors.barbie
                }
            }
        }
    }
}
```

### Options to select the variant

If you pass `undefined` or `empty object` Unsityles will try to find the `default` variant in your stylesheet:

```tsx
styles.useVariants(undefined) // will use default variant (if any)
styles.useVariants({}) // will use default variant (if any)
```

Default variant

If you don’t explicitly call `styles.useVariants`, the Unistyles C++ parser will ignore your variants and will not resolve to the `default` variant, even if it is present.

```tsx
styles.useVariants({
    color: undefined // will use default variant (if any)
})
```

Lastly, you can pass the correct variant name for a variant group:

```tsx
styles.useVariants({
    color: 'secondary' // will use secondary variant
})
```

### Pass variants as component props

Variants were designed to be used as component props:

```tsx
import React from 'react'
import { StyleSheet } from 'react-native-unistyles'


type ComponentProps = {
    color: 'primary' | 'secondary'
    size: 'small' | 'medium' | 'large'
}


const Component: React.FunctionComponent = ({ color, size }) => {
    styles.useVariants({
        color,
        size
    })


    return (
        <View style={styles.container} />
    )
}
```

### Infer TypeScript type for your variants

Instead of using `enum` or `strings` with `|` , you can use `UnistylesVariants` to infer the type of your variants:

```tsx
import React from 'react'
import { StyleSheet, UnistylesVariants } from 'react-native-unistyles'


type ComponentProps = UnistylesVariants<typeof styles>


const Component: React.FunctionComponent = ({ color, size }) => {
    styles.useVariants({
        color,
        size
    })


    return (
        <View style={styles.container} />
    )
}


// infers type of your variants from the stylesheet below
const styles = ...
```

### Defining the same variant across multiple styles

It’s possible to define the same variant group across multiple styles:

```tsx
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        variants: {
            size: {
                small: {
                    width: 100,
                    height: 100
                },
                medium: {
                    width: 200,
                    height: 200
                },
                large: {
                    width: 300,
                    height: 300
                }
            }
        }
    },
    text: {
        fontWeight: 'bold',
        variants: {
            size: {
                small: {
                    fontSize: 12
                },
                medium: {
                    fontSize: 16
                },
                large: {
                    fontSize: 20
                }
            }
        }
    }
}
```

Caution

Unistyles will work as intended, selecting the correct variant for each style. However, you need to repeat all your options like `small`, `medium`, and `large` in each style to avoid TypeScript errors.

```tsx
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        variants: {
            size: {
                small: {
                    width: 100,
                    height: 100
                },
                medium: {
                    width: 200,
                    height: 200
                },
                large: {
                    width: 300,
                    height: 300
                }
            }
        }
    },
    text: {
        fontWeight: 'bold',
        variants: {
            size: {
                small: {
                    fontSize: 12
                },
                // missing medium and large variants!
            }
        }
    }
}
```

In this case, the generated TypeScript type will be:

```plaintext
size: ('small' | 'medium' | 'large') | ('small')
```

If you don’t need all variants and want the correct type, please add empty variants:

```tsx
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        variants: {
            size: {
                small: {
                    width: 100,
                    height: 100
                },
                medium: {
                    width: 200,
                    height: 200
                },
                large: {
                    width: 300,
                    height: 300
                }
            }
        }
    },
    text: {
        fontWeight: 'bold',
        variants: {
            size: {
                small: {
                    fontSize: 12
                },
                medium: {},
                large: {}
            }
        }
    }
}
```

The generated TypeScript type will then be:

```plaintext
size: ('small' | 'medium' | 'large')
```

# Web only features

> Learn about web only features in Unistyles 3.0

Unistyles comes with some web-only features that are not available with React Native or React Native Web.

### Web only styles

In Unistyles, you can use web-specific styles for your web app under the `_web` key.

```ts
const styles = StyleSheet.create({
    container: {
        flex: 1,
        // Web only styles:
        _web: {
            display: 'grid',
        }
    }
})
```

Web styles support **any** CSS property and value that matches the `CSSProperties` type from React.

Note

The `_web` styles are ignored on Android and iOS, but are merged with other styles on web.

Within `_web` block, you can’t use any React Native specific styles:

```ts
const styles = StyleSheet.create({
    container: {
        flex: 1,
        _web: {
          display: 'grid',
          // 💥 Error! This is React Native specific style
          transform: [{ translateX: 10 }],
        }
    }
})
```

The `transform` property on the web should be a string:

```ts
const styles = StyleSheet.create({
    container: {
        flex: 1,
        _web: {
            display: 'grid',
           transform: [{ translateX: 10 }],
           transform: 'translateX(10px)',
        }
     }
})
```

If you want to use React Native specific styles on web simply move them to the `style` level:

```ts
const styles = StyleSheet.create({
    container: {
        flex: 1,
        // ✅ This is React Native specific style, and will be parsed correctly for web
        transform: [{ translateX: 10 }],
        _web: {
            display: 'grid',
           transform: [{ translateX: 10 }],
        }
    }
})
```

You can also use variants, breakpoints, and other Unistyles features under the `_web` key!

### Pseudo elements

Unistyles also introduces a way to use **any** pseudo-elements and selectors in your web styles.

```ts
const styles = StyleSheet.create(theme => ({
    button: {
        backgroundColor: theme.colors.button,
        _web: {
            _hover: {
                backgroundColor: theme.colors.hovered,
            },
            _before: {
                content: '"🦄"',
            }
        }
    },
}))
```

As you can see, `:` and `::` have been replaced with `_` for easier usage.

### Injecting custom classNames

If you want to write some part of your app with plain CSS, you can add custom `classNames` to your styles:

```ts
const styles = StyleSheet.create({
    container: {
        flex: 1,
        _web: {
            _classNames: 'my-custom-class',
        }
    }
})
```

The `_classNames` key under the `_web` key will be injected into the DOM element as a `className`. You can pass a string or an array of strings into it:

```ts
const styles = StyleSheet.create({
    container: {
        flex: 1,
        _web: {
           _classNames: 'my-custom-class',
           _classNames: ['my-custom-class', 'my-other-class'],
            // or _classNames: 'my-custom-class my-other-class'
        }
    }
})
```

You can also use some conditions while resolving your classes:

```ts
const styles = StyleSheet.create({
    button: (isPrimary: boolean) => ({
        _web: {
            _classNames: isPrimary ? 'primary-button' : 'secondary-button',
        }
    })
})
```

### CSS Variables

Unistyles 3.0 converts all your themes to CSS variables by default, eliminating heavy JS processing when changing the theme and allowing the CSS engine to take over.

In more detail, it converts all **strings** into CSS variables. For example, if we have the following theme:

```ts
const darkTheme = {
    colors: {
        primary: '#4b7594'
    },
    gap: (v: number) => v * 8,
    fontSize: 16
}
```

It will be converted to:

```css
:root.dark {
    --colors-primary: #4b7594;
}
```

After conversion, Unistyles will use CSS variable instead of string to reference the theme value.

##### If you’re using `adaptiveThemes`

CSS variables will be placed under the `@media (prefers-color-scheme)` [query](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme) ensuring that the app will automatically switch to the new theme.

##### If you’re not using `adaptiveThemes`

Class of your html root element will be updated to match the new one.

Caution

It’s possible to [disable](/v3/start/configuration#settings-optional) this feature in some cases.

### When to disable CSS variables?

##### When you have different size variables / functions in your themes

```tsx
// ❌ Not OK
const regularTheme = {
    colors: sharedColors,
    gap: (v: number) => v * 8,
    fontSize: 16
}


const largeTheme = {
    colors: sharedColors,
    // gap function has a different factor
    gap: (v: number) => v * 16,
    // fontSize is a different value
    fontSize: 32
}
```

```tsx
// ✅ OK
const lightTheme = {
    colors: {
        ...sharedColors,
        background: '#fff',
        typography: '#000'
    },
    gap: (v: number) => v * 8,
    fontSize: 16
}


const darkTheme = {
    colors: {
        ...sharedColors,
        background: '#000',
        typography: '#fff'
    },
    gap: (v: number) => v * 8,
    fontSize: 16
}
```

##### When you use conditions to style your components instead of relying on the same theme values

```tsx
// ❌ Not OK
const styles = StyleSheet.create(theme => ({
    container: {
        // this is a condition and won't work with CSS variables
        backgroundColor: theme.isDark
            ? theme.colors.grey200
            : theme.colors.grey700
    }
}))
```

```tsx
// ✅ OK
const styles = StyleSheet.create(theme => ({
    container: {
        // your rely on the same theme values across different themes
        backgroundColor: theme.colors.background
    }
}))
```

If none of the above applies to you, you can use CSS variables to boost your app’s performance.

# Web Styles

> Learn about web styles in Unistyles 3.0

Unistyles Web is independent from React Native Web, utilizing a custom web parser that directly generates CSS from your `StyleSheet` definitions.

### How It Works

Unistyles web parser generates unique `classNames` for your styles and assigns them to corresponding DOM elements. This ensures that only the necessary styles are applied, avoiding redundancy. Additionally, media queries are automatically created based on your `breakpoints`, eliminating the need for recalculation on every resize.

Example:

```ts
const styles = StyleSheet.create({
    container: {
        flex: 1,
        fontSize: 32,
    },
    text: {
        fontSize: {
            xs: 28,
            lg: 40
        },
    },
    parentContainer: {
        flex: 1,
    }
})
```

Will produce the following CSS output:

```css
# because flex: 1 is shared across multiple styles
.unistyles_1u0egm6 {
  flex: 1;
}


# to cover "container" fontSize
@media (min-width: 0px) {
  .unistyles_kaoph5 {
    font-size: 32px;
  }
}


# to cover "text" fontSize
@media (min-width: 1200px) {
  .unistyles_kaoph5 {
    font-size: 40px;
  }
}
```

### Updating Styles

When you change your app’s theme, Unistyles automatically updates your CSS without triggering any re-renders. This applies to dynamic functions and variants as well.

For instance, if you define your styles dynamically:

```ts
const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background
    }
}))
```

The generated CSS might look like this:

```css
.unistyles_1u0egm6 {
  flex: 1;
  background-color: #000;
}
```

Upon switching the theme:

```ts
UnistylesRuntime.setTheme('light')
```

The CSS will automatically update to:

```css
.unistyles_1u0egm6 {
  flex: 1;
  background-color: #fff;
}
```

### Limitations

Due to Unistyles custom parser, styles cannot be accessed directly as they would be with React Native Web. Passing styles to the `RNW` parser would modify them and generate unnecessary new classes.

As a result, when you try to `console.log` the styles, there will be no output:

```ts
const styles = StyleSheet.create({
    container: {
        flex: 1
    }
})


// This will result in an empty object since we generate classes instead of inline styles
console.log(styles) // {}
```

### Web-Only Features

Unistyles includes some features specific to the web. Learn more about them [here](/v3/references/web-only).

# withUnistyles

> Learn about how to integrate 3rd party libraries with Unistyles engine

Before reading this guide, make sure that you understand [How Unistyles works](/v3/start/how-unistyles-works) and how [Babel plugin](/v3/other/babel-plugin) manipulates your code. Also read our [decision algorithm](/v3/references/3rd-party-views) to learn when to use this factory.

### Why do you need it?

* Unistyles cannot retrieve `ShadowNode` from third-party components because they might not expose a native view via the ref prop

```ts
import { Blurhash } from 'react-native-blurhash'


const MyComponent = () => {
    return
        <Blurhash
            blurhash="LGFFaXYk^6#M@-5c,1J5@[or[Q6."
            // 💥 Oops! Blurhash is 3rd party view, that might not expose the `ref` prop
            // it will never update when theme changes
            style={styles.container}
        />
    }
}


const styles = StyleSheet.create(theme => ({
    container: {
        borderWidth: 1,
        borderColor: theme.colors.primary
    }
}))
```

* Another use case is when you use components that do not expect a `style` prop but require, for example, a `color` prop.

```ts
import { Button } from 'react-native'


const MyComponent = () => {
    return (
        <Button
            // 💥 Oops! Button is React Native component, so it has a ref, but it doesn't expect `style` prop
            // it will never update when theme changes
            // Also, from where will we get `theme` value?
            color={theme.colors.primary}
        />
    )
}
```

That’s why we created a way to subscribe such component to Unistyles updates.

Note

This pattern is only recommended when you need an escape hatch to use Unistyles with third-party components. If you don’t rely on styles in these components, you should not wrap your component with `withUnistyles`.

Caution

`withUnistyles` detects automatically your component dependencies and re-renders it only when they change.

### Auto mapping for `style` and `contentContainerStyle` props

If your component expects the `style` or `contentContainerStyle` prop, Unistyles will automatically handle the mapping under the hood. You just need to wrap your custom view in `withUnistyles`. We will also respect your style dependencies, so, for example, the `Blurhash` component will only re-render when the theme changes.

```ts
import { Blurhash } from 'react-native-blurhash'
import { withUnistyles } from 'react-native-unistyles'


// ✨ Magic auto mapping
const UniBlurHash = withUnistyles(Blurhash)


const MyComponent = () => {
    return (
        <UniBlurHash
            blurhash="LGFFaXYk^6#M@-5c,1J5@[or[Q6."
            // now Blurhash will re-render when theme changes
            style={styles.container}
        />
    )
}


const styles = StyleSheet.create(theme => ({
    container: {
        borderWidth: 1,
        // blurhash depends on theme
        borderColor: theme.colors.primary
    }
}))
```

### Mapping custom props to Unistyles styles

If you need to ensure your component updates but it doesn’t use `style` or `contentContainerStyle` props, you can use `mappings`:

```ts
import { Button } from 'react-native'
import { withUnistyles } from 'react-native-unistyles'


// ✨ Some magic happens under the hood
const UniButton = withUnistyles(Button, (theme, rt) => ({
    // map `primary` color to `color` prop
    color: theme.colors.primary
    // any other props that Button supports
}))


const MyComponent = () => {
    return (
        // you don't need to specify color props here
        <UniButton />
    )
}
```

TypeScript will autocomplete all your props, so there is no need to specify type manually.

### Custom mappings for external props

Sometimes, you might want to map your props based on a function or value that is only accessible within the component. For example, if you are using `FlashList` and want to modify the `numColumns` prop based on a condition. Using `mappings` in `withUnistyles` is not an option because it doesn’t allow referencing other props.

```tsx
import { withUnistyles } from 'react-native-unistyles'
import { FlashList } from 'react-native-flash-list'


const MyFlashList = withUnistyles(FlashList, (theme, rt) => ({
    numColumns: 💥 Oops! getNumColumns function is not available here
}))


const MyComponent = () => {
    const getNumColumns = () => {
        // your logic
    }


    return (
        <MyFlashList />
    )
}
```

Another example is React Native’s `Switch` component:

```tsx
import { Switch } from 'react-native'
import { withUnistyles } from 'react-native-unistyles'


const MySwitch = withUnistyles(Switch, (theme, rt) => ({
    trackColor: 💥 Opps! isDisabled prop is not available here
}))


const MyComponent = ({ isDisabled }) => {
    return (
        <MySwitch />
    )
}
```

For such dynamic mappings, we provide a prop called `uniProps` that allows you to pass any props to the component. From there, you can access any function or variable or map the prop to any value based on your state and needs.

```tsx
import { Switch } from 'react-native'
import { withUnistyles } from 'react-native-unistyles'


// leave it empty here
const MySwitch = withUnistyles(Switch)


const MyComponent = ({ isDisabled }) => {
    return (
        <MySwitch
            uniProps={(theme, rt) => ({
                trackColor: isDisabled
                    ? theme.colors.disabled
                    : theme.colors.primary
            })}
        />
    )
}
```

`uniProps` is a function that receives `theme` and `rt` as arguments. These values will be always up-to-date, so you can use them to map colors or value to new props.

Note

Components that use `uniProps` are also aware of your dependencies. In the example above, `MySwitch` will re-render only when `theme` changes.

### Props resolution priority

We will respect your order of prop resolution, applying them with the following priority:

1. Global mappings
2. `uniProps`
3. Inline props

**Example: Modifying a Button**

```ts
// By default, Button is red
const UniButton = withUnistyles(Button, theme => ({
    color: theme.colors.red
}))


// `uniProps` have higher priority,
// so the button is orange
<UniButton
    uniProps={theme => ({
       color: theme.colors.orange
    })}
/>


// Inline props have the highest priority,
// so Button is pink
<UniButton
    color="pink"
    uniProps={theme => ({
       color: theme.colors.orange
    })}
/>
```

# LLMS

> How to feed LLMS with Unistyles 3.0

Unistyles can feed LLMs with auto-generated documentation:

* [llms.txt](https://www.unistyl.es/llms.txt)
* [short documentation](https://unistyl.es/llms-small.txt)
* [full documentation](https://unistyl.es/llms-full.txt)

# Babel plugin

> How Unistyles babel plugin works?

Unistyles 3.0 relies heavily on the Babel plugin, which helps convert your code in a way that allows binding the `ShadowNode` with `Unistyles`. Before reading this guide, make sure to check the [Look under the hood](/v3/start/how-unistyles-works) guide.

Our golden rule is to never introduce any component that could pollute your native view hierarchy. In other words, if you use a `View`, it will be rendered as-is in the native view hierarchy.

Let’s discuss the responsibilities of the Babel plugin:

### 1. Detecting StyleSheet dependencies

Each `StyleSheet` is different. One might rely on a `theme`, another on `miniRuntime`, and so on. The same applies to `styles`. Each style depends on different things. For example, you can wrap your app in a `View` that safeguards your app from rendering behind the notch or navigation bar. Another style might be used in your `Typography` component and provides text color based on the apps’ theme.

Should the `Typography` style re-calculate on an `insets` change? Or should the `View` that relies on insets re-render on a theme change?

We don’t think that’s a good idea. The first responsibility of the Babel plugin is to detect all dependencies in your `StyleSheet`. This ensures that only the relevant styles are recalculated when necessary.

```ts
// Babel: depends on theme
const stylesheet = StyleSheet.create(theme => ({
    container: {
        // Babel: depends on theme
        backgroundColor: theme.colors.background
    },
    text: {
        // Babel: static (no dependencies)
        fontSize: 12
    }
}))
```

```ts
// Babel: depends on theme and miniRuntime
const stylesheet = StyleSheet.create((theme, rt) => ({
    container: {
        // Babel: depends on theme and insets
        paddingTop: rt.insets.top,
        paddingBottom: rt.insets.bottom,
        backgroundColor: theme.colors.background
    },
    text: (fontSize: number) => ({
        // Babel: depends on theme
        color: theme.colors.text,
        // Babel: depends on fontScale
        fontSize: rt.fontScale >= 3
            ? fontSize * 1.5
            : fontSize * 0.8
    })
}))
```

Dependency detection limitation

We put a lot of effort into making dependency detection as accurate as possible, thus we support:

* destructuring of `theme` and `rt` objects
* style’s as functions / arrow functions / objects
* nested ifs and other conditionals
* ternary operators
* logical operators
* binary operators
* and much more…

**What we don’t support**:

* moving functions/arrow functions out of StyleSheet.create
* `theme` and `rt` reassignment to other variables (we don’t track them)

### 2. Attaching unique id to each StyleSheet

This helps us identify your `StyleSheet` while you’re developing your app and trigger multiple `hot-reloads`. Such identification is required to swap your `StyleSheet` with another one, ensuring that you get up-to-date values during reloads. This feature does not affect your app in production, as the bundle never reloads in that environment.

### 3. Component factory (borrowing ref)

This is the most crucial part—without it, Unistyles won’t be able to update your views from C++. In the early versions of Unistyles 3.0, we tried solving this problem by using the `ref` prop, but it wasn’t reliable enough. Many developers use different style syntaxes, making it impossible to support all of them.

Instead, we decided to leave the user’s `ref` as is and transfer the implementation from Babel to our component factory. This way we have more control and we have an unified way of registering your `ShadowNodes`.

The component factory is a function that takes your component and renders it with an overridden `ref` prop:

```ts
const factory = Component => <Component ref={someMagic✨} {...props} />;
```

Note

We override your `ref` prop to connect a `ShadowNode` to the attached Unistyle(s). From the runtime perspective, your component will render the same way as before! We only borrow your `ref` momentarily to update the ShadowRegistry.

We’re also React 19–ready and will call your `ref` cleanup function if it’s present.

Let’s go through some examples so you can better understand how this works:

Your code

```ts
import { View } from 'react-native'


const ref = useRef()


<View ref={ref} />
```

Babel transform

```ts
import { View } from 'react-native-unistyles/src/components/native/View'


const ref = useRef()


// no changes
<View ref={ref} />
```

We also support other components to extract `ShadowNode` from them:

Your code

```ts
import { Pressable, Image } from 'react-native'


<Pressable
    ref={ref => {
        doSomething(ref)
    }}
    onPress={() => {}}
/>
<Image source={require('./image.png')} style={styles.image} ref={ref2} />
```

Babel transform

```ts
import { Pressable } from 'react-native-unistyles/components/native/Pressable'
import { Image } from 'react-native-unistyles/components/native/Image'


// no changes
<Pressable
    ref={ref => {
        doSomething(ref)
    }}
    onPress={() => {}}
/>
<Image source={require('./image.png')} style={styles.image} ref={ref2} />
```

### 4. Creating scopes for stateless variants

When you use variants, each time you call `useVariants`, a new scope is created. This scope contains a local copy of stylesheet that won’t affect other components. This feature is similar to time travel, allowing you to explore different states of your styles with different calls to `useVariants`.

From your perspective, using variants is simple: you just need to call the `useVariants` hook:

```tsx
styles.useVariants({
    size: 'small'
})
```

Behind the scenes, we create a scoped constant that can be accessed anywhere within the same block:

```tsx
const _styles = styles
{
    const styles = _styles.useVariants({
        size: 'small'
    })


    // Your code here
}
```

This approach also works seamlessly with `console.log`, allowing you to inspect styles at any point:

```tsx
// Styles without variants
console.log(styles.container)


styles.useVariants({
    size: 'small'
})


// Styles with variants: small
console.log(styles.container)


styles.useVariants({
    size: 'large'
})


// Styles with variants: large
console.log(styles.container)
```

By leveraging such scopes, we ensure support for any level of nesting!

### Extra configuration

The Babel plugin comes with a few additional options to extend its usage.

Caution

By default babel plugin will look for any `react-native-unistyles` import to start processing your file. You can change this behaviour with options below:

### `root` (required)

All files within the specified root folder will be processed by the Babel plugin. If you need to process extra folders, use with `autoProcessPaths` option.

```js
{
    root: 'src' // or 'app', or any name of your root folder
}
```

Folder name will be resolved with `process.cwd()`.

Note

If you use monorepo or a project with Expo Router, you most likely have multiple root folders.

In that case:

* set `root` to the folder containing your components eg. `@myapp/ui` or `components`
* use the `autoProcessImports` option to whitelist your folder (check example below)

### `autoProcessImports`

This configuration should be used when you want to process files containing specific imports. It can be useful for monorepos that use Unistyles with absolute paths, such as `@codemask/styles`.

```js
{
    autoProcessImports: ['@codemask/styles'] // whenever Babel encounters this import, it will process your file
}
```

### `autoRemapImports`

This is the most powerful option, but most likely, you won’t need to use it. It allows you to remap uncommon imports to Unistyles components.

This may happen if a 3rd library does not import `react-native` components directly, but instead uses its own factory or a relative path. Unistyles uses it internally to support the following imports from `react-native` internals:

```js
import { NativeText } from "react-native/Libraries/Text/TextNativeComponent"
import View from "react-native/Libraries/Components/View/ViewNativeComponent"
```

Let’s say you have a library called `custom-library` that imports `react-native` raw components directly:

node\_modules/custom-library/components/index.js

```js
import { NativeText } from "react-native/Libraries/Text/TextNativeComponent"
import View from "react-native/Libraries/Components/View/ViewNativeComponent"
```

To convert it to Unistyles, you can use the following configuration:

```ts
{
    autoRemapImports: [
        path: 'node_modules/custom-library/components', // <- must be path from node_modules
        imports: [
            {
                isDefault: false, // <- is default import?
                name: 'NativeText', // <- if not, what's the import name?
                path: 'react-native/Libraries/Text/TextNativeComponent' // <- what's the import source?
                mapTo: 'NativeText' // <- which Unistyles component should be used? Check react-native-unistyles/src/components/native
            },
            {
                isDefault: true,
                path: 'react-native/Libraries/Components/View/ViewNativeComponent',
                mapTo: 'NativeView'
            }
        ]
    ]
}
```

Caution

If you use raw `react-native` imports within your code, Unistyles will auto map it to `react-native-unistyles` factories. This option should only be used for 3rd party libraries from `node_modules`.

### `autoProcessPaths`

This configuration is unrelated to the `root`, `autoProcessImports`, and `autoRemapImports` options and can be used alongside them. By default, the Babel plugin ignores `node_modules`. However, you can extend these paths to attempt converting 3rd components into Unistyles compatible ones. Within these paths, we will replace `react-native` imports with `react-native-unistyles` factories that borrow component refs. [Read more](/v3/other/babel-plugin#3-component-factory-borrowing-ref).

Defaults to:

```ts
['react-native-reanimated/src/component']
```

### `debug`

In order to list detected dependencies by the Babel plugin you can enable the `debug` flag. It will `console.log` name of the file and component with Unistyles dependencies.

### Usage with React Compiler

Check [this guide](/v3/guides/react-compiler) for more details.

#### Usage in `babel.config.js`

You can apply any of the options above as follows:

babel.config.js

```js
/** @type {import('react-native-unistyles/plugin').UnistylesPluginOptions} */
const unistylesPluginOptions = {
    // any component in this folder will be processed
    root: 'src',
    // also files with these imports will be processed (in any non-root folder)
    autoProcessImports: ['@react-native-ui-kit', '@codemask/styles'],
    // additionally process components from this `node_modules` package
    autoProcessPaths: ['external-library/components'],
    // log what you've found
    debug: true,
}


module.exports = function (api) {
    api.cache(true)


    return {
        // other config
        plugins: [
            ['react-native-unistyles/plugin', unistylesPluginOptions]
            // other plugins
        ]
    }
}
```

# Dependencies

> Learn about Unistyles dependencies

Unistyles 3.0 minimizes dependencies to keep your app as lightweight as possible. In the latest version, we’ve opted to include only two essential dependencies that are shaping the future of the React Native ecosystem.

### Nitro Modules

Developed by: [Marc Rousavy](https://github.com/mrousavy)

[Nitro modules](https://nitro.margelo.com/) help Unistyles speed up development time by offering remarkable solutions:

* Type-safe interfaces across multiple languages (`TypeScript`, `C++`, `Swift`, and `Kotlin`)
* Generating bindings from a single source of truth (specification files)
* A thin layer that accelerates calls from `JavaScript` to `C++`, `Swift`, or `Kotlin`
* The ability to convert repository from Objective-C to Swift
* Support for calling Swift code directly, without routing it through Objective-C++

We highly encourage you to give Nitro a star ⭐ or support Marc through sponsorship.

### React Native Edge to Edge

Developed by: [Mathieu Acthernoene](https://github.com/zoontek)

[React Native Edge to Edge](https://github.com/zoontek/react-native-edge-to-edge) is a library aimed at unifying the handling of edge-to-edge layouts on Android. We fully support this initiative and have made it a dependency for Unistyles.

You likely won’t notice any changes, as Unistyles has enforced edge-to-edge layouts since version 2.8.0. However, other libraries that detect `react-native-edge-to-edge` can now reliably assume that this mode is enabled. Additionally, Mathieu’s initiative is supported by [Expo](https://docs.expo.dev/), which suggests it may become a standard in the future.

If you use any of Mathieu’s libraries, such as `react-native-permissions` or `react-native-bootsplash`, we encourage you to give them a star ⭐ and support him through sponsorship.

# For library authors

> How to use Unistyles 3.0 in your library

Unistyles is highly extensible and can be used to build UI kits and various other projects. We maintain the core, so you can create any abstraction on top of it.

## Using Unistyles in your library

`StyleSheet.configure` **must** be invoked as soon as possible, before any user code references any `StyleSheet` from your library.

You can then call `StyleSheet.configure` multiple times to override configurations. However, keep in mind that `StyleSheet.configure` makes a roundtrip to C++, which can add a few `ms` to your app’s startup time.

To manipulate your config without replacing it, use [UnistylesRuntime](/v3/references/unistyles-runtime/).

## Unistyles never re-renders

Unistyles’ C++ core ensures that your components never re-render. Instead, they are updated directly from C++ and `Shadow Tree`.

## No React Context - no additional setup

Unistyles does not use the React Context API. This means that users do not need to wrap their app with a `Provider`, reducing boilerplate code and making your library more user-friendly.

## New architecture only

Unistyles won’t re-render your components unless you want to. While it requires enabling the New Architecture, we believe this trade-off is worthwhile, as more apps are expected to transition to the New Architecture in the coming months.

Note

As of June 2nd, 2025, Old Architecture is [frozen](https://github.com/reactwg/react-native-new-architecture/discussions/290). It means it is the best time to rely on New Architecture.

## Minimum requirements

Unistyles is compatible with:

* React Native version >= 0.78
* TypeScript > 5.0
* iOS 15.0+
* Android 7+

## Out of the box support for Web

Building a UI kit for both React Native and Web couldn’t be easier. Unistyles automatically manages your styles and converts them into CSS classes.

## Babel config

Make sure to instruct your users to add [autoProcessPaths](/v3/other/babel-plugin#extra-configuration) babel option. It will whitelist your `ui-kit` and process your files even though there are in `node_modules` folder.

You can also consider publishing your UI kit with babel transforms in place. Keep in mind that it could break [testing](/v3/start/testing) views with your components.

## Why to choose Unistyles?

Unistyles offers a unique architecture unavailable in any other library. Fully compatible with the React Native StyleSheet API, it is easy to use and extend.

By avoiding component abstraction, Unistyles gives you the freedom to create your own. It supports various platforms and is designed to be easily extendable.

Tip

If you need any cool feature to support your UI Kit, please open a [discussion](https://github.com/jpudysz/react-native-unistyles/discussions).

I’m happy to help you with your use case!

Do you have any questions? Feel free to ask in our [Discord](https://discord.gg/akGHf27P4C).

# For sponsors

> Sponsor Unistyles 3.0 development

Thank you for all the sponsorships!

We’re so exited about Unistyles 3.0 core and can’t wait for the new possibilities that Unistyles 4.0 will bring!

### Why sponsor Unistyles?

* **Advancing Innovation**: Your sponsorship helps in the continuous innovation and improvement of Unistyles. This support is crucial for developing new features and maintaining the library
* **Benefit for Developers and Companies**: Both individual developers and large companies that profit from using Unistyles stand to gain from its enhancements. Your support ensures that Unistyles remains a cutting-edge tool in your development arsenal
* **Limited Free Time Challenge**: The development of innovative libraries like Unistyles is often constrained by the limited free time of creators. Sponsorship can provide the necessary resources for dedicated development time

### How to sponsor?

* **Github Sponsorship**: [link](https://github.com/sponsors/jpudysz)
* **Ko-Fi**: [link](https://ko-fi.com/jpudysz)

### Free options

* **Sharing Unistyles**: A free yet impactful way to support us is by sharing information about Unistyles within your network. Spreading the word helps increase our visibility and user base
* **Shoutout**: Give us a shoutout on X or Reddit. Public endorsements and mentions can significantly boost our project’s presence and reach

### Other options

Hire Codemask team

If you’re looking to hire a skilled React Native team, Codemask is open for collaboration. We offer expertise and quality in building React Native applications.

[Contact Codemask](https://codemask.com/contact)

Build something extraordinary

As a Codemask CTO I’m open to share my knowledge and expertise in the React Native ecosystem. Do you need help building a custom native library, or a private project? I’m here to help.

[Contact me on X](https://x.com/jpudysz) or [Contact me with email](mailto:jacekpudysz@gmail.com)

# FAQ

> Frequently asked questions about Unistyles 3.0

### Can I run Unistyles on Expo Go?

No, Unistyles includes custom native code, which means it does not support Expo Go.

### What happened to `macOS`, `windows`, `visionOS`, `tvOS` support?

For now they’re not available. We’re seeking sponsors to help us add support, as they are rarely used by our customers.

### Can I run Unistyles on `Old Architecture`?

No, Unistyles is tightly integrated with `Fabric`. There are no plans to support `Old Architecture`.

### We are not ready to upgrade. What will happen with version `2.0`?

We understand that some apps require more time to migrate to the `New Architecture`. We plan to support Unistyles 2.0 for a few more months or stable React Native versions.

### Adaptive mode doesn’t work for me

To enable adaptive mode, you need to register two themes named `light` and `dark` and set the `adaptiveThemes` flag to true within `StyleSheet.configure`.

If your app still doesn’t automatically switch themes, ensure that:

* For Expo your `app.json` contains a `userInterfaceStyle` key with the value automatic
* For bare React Native, your `Info.plist` does not have the `UIUserInterfaceStyle` key set to a hardcoded value
* `Appearance` from `react-native` is set to null
* You have phone with iOS 15+ or Android 10+
* Your device supports dark mode

### ld.lld: error: Undefined symbols margelo::nitro::\*

This error occurs due to the strong caching mechanism in Android Studio. The cache can even survive the `expo prebuild --clean` command in Expo projects.

To clean the cache, please follow these steps:

```sh
cd android
./gradlew clean
git clean -dfX
```

Now, try rebuilding your app.

# Part 3: Cleanup components

> Learn how to build a cross-platform app from scratch with Unistyles 3.0, Expo, and Reanimated

Now that our screens are adapted, let’s refactor the default components. This is where we’ll see the true power of Unistyles in cleaning up component logic. We’ll focus on `ThemedText` and `ThemedView`. The other files can be removed.

After cleaning up, your components folder should look like this:

* app/

  * …

* components/

  * ui/

    * IconSymbol.ios.tsx
    * IconSymbol.tsx
    * TabBarBackground.ios.tsx
    * TabBarBackground.tsx

  * ThemedText.tsx

  * ThemedView\.tsx

### ThemedText

The default `ThemedText` component is a perfect candidate for a Unistyles refactor. It contains conditional style logic directly in the JSX - a pattern we can significantly improve.

First, let’s swap the `StyleSheet` import and remove unnecessary `useThemeColor` hook.

components/ThemedText.tsx

```tsx
import { StyleSheet, Text, type TextProps } from 'react-native';
import { Text, type TextProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useThemeColor } from '@/hooks/useThemeColor';
```

The original component used the `useThemeColor` hook to get a color based on the current theme. We’ll replace this imperative logic with a dynamic function in our stylesheet. A dynamic function is a Unistyles feature that allows a style to accept arguments. Let’s create one called `textColor` to handle the `lightColor` and `darkColor` props.

components/ThemedText.tsx

```tsx
export function ThemedText({
  style,
  lightColor,
  darkColor,
  type = 'default',
  ...rest
}: ThemedTextProps) {
 const color = useThemeColor({ light: lightColor, dark: darkColor });


  return (
    <Text
      style={[
        { color },
        styles.textColor(lightColor, darkColor),
        type === 'default' ? styles.default : undefined,
        type === 'title' ? styles.title : undefined,
        type === 'defaultSemiBold' ? styles.defaultSemiBold : undefined,
        type === 'subtitle' ? styles.subtitle : undefined,
        type === 'link' ? styles.link : undefined,
        style,
      ]}
      {...rest}
    />
  );
}


const styles = StyleSheet.create({
  default: {
    fontSize: 16,
    lineHeight: 24,
  },
  textColor: (lightColor?: string, darkColor?: string) => ({
     // todo
  }),
  defaultSemiBold: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    lineHeight: 32,
  },
  subtitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  link: {
    lineHeight: 30,
    fontSize: 16,
    color: '#0a7ea4',
  },
});
```

Note

Learn more about dynamic functions and how they work in the dedicated [guide](/v3/references/dynamic-functions).

To implement this, we need to know the current color scheme. Unistyles provides access to this via the runtime object (which we’ll alias as rt).

What’s unique compared to React Native `StyleSheet` is that with Unistyles your `StyleSheet` can be converted to a function that receives both the `theme` and the `rt` as arguments. First argument - `theme` is the current, always up-to-date theme object. Second argument - `rt` is the runtime object, containing useful device metadata, including `rt.colorScheme`.

Note

If you’re interested in learning more about the `rt` object, check out the [mini runtime guide](/v3/references/mini-runtime).

Because we are accessing a runtime value, Unistyles is smart enough to know this style depends on the color scheme and will automatically update it when it changes - without re-rendering the component!

Let’s complete our dynamic function:

components/ThemedText.tsx

```tsx
export function ThemedText({
  style,
  lightColor,
  darkColor,
  type = 'default',
  ...rest
}: ThemedTextProps) {
  return (
    <Text
      style={[
        styles.textColor(lightColor, darkColor),
        type === 'default' ? styles.default : undefined,
        type === 'title' ? styles.title : undefined,
        type === 'defaultSemiBold' ? styles.defaultSemiBold : undefined,
        type === 'subtitle' ? styles.subtitle : undefined,
        type === 'link' ? styles.link : undefined,
        style,
      ]}
      {...rest}
    />
  );
}


 const styles = StyleSheet.create({
 const styles = StyleSheet.create((theme, rt) => ({
  default: {
    fontSize: 16,
    lineHeight: 24,
  },
  textColor: (lightColor: string, darkColor: string) => ({
    // todo
    color: rt.colorScheme === 'dark' ? darkColor : lightColor,
  }),
  defaultSemiBold: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    lineHeight: 32,
  },
  subtitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  link: {
    lineHeight: 30,
    fontSize: 16,
    color: '#0a7ea4',
  },
 })
 }));
```

Next, let’s tackle the chain of conditional checks for the type prop. This is a classic use case for variants. Variants allow you to move all of this style logic out of your component and into the stylesheet.

components/ThemedText.tsx

```tsx
export function ThemedText({
  style,
  lightColor,
  darkColor,
  type = 'default',
  ...rest
}: ThemedTextProps) {
  return (
    <Text
      style={[
        styles.textColor(lightColor, darkColor),
        type === 'default' ? styles.default : undefined,
        type === 'title' ? styles.title : undefined,
        type === 'defaultSemiBold' ? styles.defaultSemiBold : undefined,
        type === 'subtitle' ? styles.subtitle : undefined,
        type === 'link' ? styles.link : undefined,
        style,
      ]}
      {...rest}
    />
  );
}


const styles = StyleSheet.create((theme, rt) => ({
  default: {
    fontSize: 16,
    lineHeight: 24,
  },
  textColor: (lightColor?: string, darkColor?: string) => ({
    color: rt.colorScheme === 'dark' ? darkColor : lightColor,
  }),
  defaultSemiBold: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    lineHeight: 32,
  },
  subtitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  link: {
    lineHeight: 30,
    fontSize: 16,
    color: '#0a7ea4',
  },
}));
```

components/ThemedText.tsx

```tsx
export function ThemedText({
  style,
  lightColor,
  darkColor,
  type = 'default',
  ...rest
}: ThemedTextProps) {
 styles.useVariants({ type })


  return (
    <Text
      style={[
        styles.textColor(lightColor, darkColor),
        styles.textType,
        style,
      ]}
      {...rest}
    />
  );
}


const styles = StyleSheet.create((theme, rt) => ({
  textType: {
    variants: {
        type: {
            default: {
                fontSize: 16,
                lineHeight: 24,
            },
            defaultSemiBold: {
                fontSize: 16,
                lineHeight: 24,
                fontWeight: '600',
            },
            title: {
                fontSize: 32,
                fontWeight: 'bold',
                lineHeight: 32,
            },
            subtitle: {
                fontSize: 20,
                fontWeight: 'bold',
            },
            link: {
                lineHeight: 30,
                fontSize: 16,
                color: '#0a7ea4',
            },
        }
    }
  },
  textColor: (lightColor?: string, darkColor?: string) => ({
    color: rt.colorScheme === 'dark' ? darkColor : lightColor,
  }),
}));
```

Notice how much cleaner the component is! We simply pass the `type` prop to the `useVariants` hook, and Unistyles applies the correct styles from our variants block.

To make this component perfectly type-safe, we can use the `UnistylesVariants` helper type. It automatically infers all possible variant props from your stylesheet.

Currently, our component has following props:

components/ThemedText.tsx

```tsx
export type ThemedTextProps = TextProps & {
  lightColor?: string;
  darkColor?: string;
  type?: 'default' | 'title' | 'defaultSemiBold' | 'subtitle' | 'link';
};
```

Instead of specifying `type` prop manually, we can use `UnistylesVariants` generic type:

components/ThemedText.tsx

```tsx
 import { StyleSheet } from 'react-native-unistyles';
 import { StyleSheet, type UnistylesVariants } from 'react-native-unistyles';


 export type ThemedTextProps = TextProps & {
 export type ThemedTextProps = TextProps & UnistylesVariants<typeof styles> & {
  lightColor?: string;
  darkColor?: string;
  type?: 'default' | 'title' | 'defaultSemiBold' | 'subtitle' | 'link';
};


export function ThemedText({
  style,
  lightColor,
  darkColor,
  type = 'default',
  type,
  ...rest
}: ThemedTextProps) {
```

Our component is clean, but we can make it even better! Why are we passing `lightColor` and `darkColor` as props when Unistyles already has access to our app theme?

Let’s remove those props and use the theme object directly.

components/ThemedText.tsx

```tsx
import { Text, type TextProps } from 'react-native';
import { StyleSheet, type UnistylesVariants } from 'react-native-unistyles';


 export type ThemedTextProps = TextProps & UnistylesVariants<typeof styles>
 export type ThemedTextProps = TextProps & UnistylesVariants<typeof styles> & {
  lightColor?: string;
  darkColor?: string;
 };


export function ThemedText({
  style,
  lightColor,
  darkColor,
  ...rest
}: ThemedTextProps) {
  return (
    <Text
      style={[
        styles.textColor(lightColor, darkColor),
        styles.textColor,
        styles.textType,
        style,
      ]}
      {...rest}
    />
  );
}


 const styles = StyleSheet.create(theme => ({
 const styles = StyleSheet.create((theme, rt) => ({
  textColor: (lightColor?: string, darkColor?: string) => ({
    color: rt.colorScheme === 'dark' ? darkColor : lightColor,
  }),
  textColor: {
    color: theme.colors.typography
  },
  textType: {
    variants: {
      type: {
        default: {
          fontSize: 16,
          lineHeight: 24,
        },
        title: {
          fontSize: 32,
          fontWeight: 'bold',
          lineHeight: 32,
        },
        subtitle: {
          fontSize: 20,
          fontWeight: 'bold',
        },
        link: {
          lineHeight: 30,
          fontSize: 16,
          color: '#0a7ea4',
          color: theme.colors.link
        },
      }
    }
  }
}));
```

**Why did we remove the extra code?**

We no longer pass as props `lightColor` and `darkColor` because those colours now come straight from the theme (typography color). When you change the `colorScheme` or update the theme, Unistyles automatically injects the new values into your `StyleSheet`, so there’s nothing to manage manually. Keeping all theming logic inside the `StyleSheet` avoids duplicated work and makes the code easier to maintain.

For the same reason, the `dynamic function` is no longer needed - we’ve replaced it with a regular style object.

This is the final, fully refactored `ThemedText` component. It’s declarative, type-safe, and completely decoupled from style logic.

Note

Curious to learn more about variants? Check out the [variants guide](/v3/references/variants).

### ThemedView - your turn!

Now is the time to refactor the `ThemedView` component. This one is much simpler. Based on what you’ve learned, try refactoring it yourself to use the `theme.colors.background` property.

Once you’re done, check your work against the solution below:

components/ThemedView\.tsx

```tsx
import { View, type ViewProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';


export type ThemedViewProps = ViewProps;


export function ThemedView({ style, ...otherProps }: ThemedViewProps) {
  return <View style={[styles.container, style]} {...otherProps} />;
}


const styles = StyleSheet.create(theme => ({
  container: {
    backgroundColor: theme.colors.background,
  }
}));
```

### Constants and hooks

Lastly, we can remove the `constants` and `hooks` folders, as they are now redundant. Your final project structure should be clean and organized.

* app/

  * (tabs)/

    * index.tsx
    * explore.tsx
    * \_layout.tsx

  * +not\_found.tsx

  * \_layout.tsx

* assets/

  * fonts/

    * …

  * images/

    * …

* components/

  * ui/

    * IconSymbol.ios.tsx
    * IconSymbol.tsx
    * TabBarBackground.ios.tsx
    * TabBarBackground.tsx

  * ThemedText.tsx

  * ThemedView\.tsx

If you run the app now, it should look and function correctly, but its internal styling logic is now far more powerful and maintainable.

[ Previous](/v3/tutorial/cleanup-screens)

[Part 2: Cleanup screens](/v3/tutorial/cleanup-screens)

[Next ](/v3/tutorial/new-screens)

[Part 4: New Screens](/v3/tutorial/new-screens)

# Part 2: Cleanup screens

> Learn how to build a cross-platform app from scratch with Unistyles 3.0, Expo, and Reanimated

Before we start building our own features, let’s adapt the default Expo Router template. The starter project includes its own theming and styling logic, which we’ll replace with the more powerful Unistyles approach.

### App folder

Let’s start with the root layout file for the entire application.

* app/

  * (tabs)/

    * …

  * \_layout.tsx

  * +not\_found.tsx

This file sets up the root `Stack` navigator and uses React Navigation’s `ThemeProvider` along with a `useColorScheme` hook. We no longer need these, as Unistyles will now manage the app’s theme state globally.

Let’s remove the old theming logic:

app/\_layout.tsx

```tsx
import React from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';


import { useColorScheme } from '@/hooks/useColorScheme';


export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [loaded] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });


  if (!loaded) {
    // Async font loading only occurs in development.
    return null;
  }


  return (
    <React.Fragment>
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="+not-found" />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
    </React.Fragment>
  );
}
```

Next, for the `+not_found.tsx` file, we only need to swap the `StyleSheet` import to use Unistyles:

app/+not\_found.tsx

```tsx
import { StyleSheet } from 'react-native-unistyles';
import { StyleSheet } from 'react-native';
```

### (tabs) folder

This folder contains the layout and screens for your `TabsNavigator`. For the `index.tsx` and `explore.tsx` files, the process is the same: we simply need to replace the standard `StyleSheet` import with the one from Unistyles.

app/(tabs)/index.tsx

```tsx
import { Platform, StyleSheet } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
```

For the JSX, we won’t need all these boilerplate components, so we can keep it as simple as possible:

app/(tabs)/index.tsx

```tsx
import { StyleSheet } from 'react-native-unistyles';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';


export default function HomeScreen() {
  return (
      <ThemedView style={styles.container}>
        <ThemedText type="title">
          Home Screen
        </ThemedText>
      </ThemedView>
  );
}


const styles = StyleSheet.create(theme => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
```

Repeat the same steps for the `(tabs)/explore.tsx` file.

app/(tabs)/explore.tsx

```tsx
import { StyleSheet } from 'react-native-unistyles';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';


export default function TabTwoScreen() {
  return (
      <ThemedView style={styles.container}>
        <ThemedText type="title">
          Explore Screen
        </ThemedText>
      </ThemedView>
  );
}


const styles = StyleSheet.create(theme => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
```

Accessing the Theme

Have you noticed how we access the theme object?

```tsx
const styles = StyleSheet.create(theme => ({ ... }))
```

This approach is slightly different from the standard React Native `StyleSheet.create` API. With Unistyles, your `StyleSheet.create` function will be automatically re-invoked whenever the theme changes, ensuring your styles are always up-to-date.

**If you’re following the tutorial on the web, you might see an error because additional configuration is required for web support. For now, focus on iOS. We’ll show you how to get it working on the web later.**

The most interesting file here is `_layout.tsx`, which configures the `Tabs` navigator. The default code uses the `useColorScheme` hook to dynamically set the `tabBarActiveTintColor`. Since `@react-navigation` components aren’t aware of the Unistyles C++ core, they can’t be updated automatically. We need a way to get the current theme data into our component and trigger a re-render when the theme changes. This is the perfect use case for the `useUnistyles` hook. It subscribes the component to theme changes, giving you access to the theme object and ensuring the component re-renders when the theme is updated.

Note

The `useUnistyles` hook is powerful but should be used selectively, primarily for integrating with third-party components that need to react to theme changes. To help you decide when to use it, we’ve created a [decision algorithm](/v3/references/3rd-party-views)

Let’s refactor tab layout to use our new theme:

app/(tabs)/\_layout.tsx

```tsx
import { Tabs } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';


 import { HapticTab } from '@/components/HapticTab';
import { IconSymbol } from '@/components/ui/IconSymbol';
 import TabBarBackground from '@/components/ui/TabBarBackground';
 import { Colors } from '@/constants/Colors';
 import { useColorScheme } from '@/hooks/useColorScheme';
 import { useUnistyles } from 'react-native-unistyles';


export default function TabLayout() {
  const colorScheme = useColorScheme();
  const { theme } = useUnistyles();


  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        tabBarInactiveTintColor: theme.colors.tint,
        tabBarActiveTintColor: theme.colors.activeTint,
        sceneStyle: {
          backgroundColor: theme.colors.background
        },
        tabBarStyle: {
          backgroundColor: theme.colors.foreground
        },
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarBackground: TabBarBackground,
        tabBarStyle: Platform.select({
          ios: {
            // Use a transparent background on iOS to show the blur effect
            position: 'absolute',
          },
          default: {},
        }),
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="paperplane.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}
```

With these changes, you can now switch your device’s color scheme, and you’ll see the tab bar’s tint color update instantly, powered by Unistyles!

![ios app preview](/_astro/tutorial-2.BW7uS7gg.jpg)

[ Previous](/v3/tutorial/intro)

[Part 1: Intro](/v3/tutorial/intro)

[Next ](/v3/tutorial/cleanup-components)

[Part 3: Cleanup components](/v3/tutorial/cleanup-components)

# Part 8: Cross-platform

> Learn how to build a cross-platform app from scratch with Unistyles 3.0, Expo, and Reanimated

We’re in the final stretch! Our music app is looking great, but there’s one important piece missing. While users can browse songs, navigate between screens, and change theme settings, the accent color selection doesn’t actually work yet. The Button and PlayerControls components still use hardcoded “banana” colors.

In this final part, we’ll connect all the pieces together using a lightweight state management solution, making our app truly dynamic and personalized. We’ll also ensure our app works beautifully across iOS, Android, and Web platforms.

### Adding State Management with StanJS

For managing the user’s accent preference across our app, we need a state management solution that’s both lightweight and efficient. After considering various options, we decided to use our in-house library called StanJS.

Note

StanJS is a powerful yet simple state management library that works similarly to `useUnistyles` subscriptions - only components that listen to specific changes will re-render. Learn more at [StanJS Documentation](https://codemask-labs.github.io/stan-js/).

StanJS automatically generates setters for your state values and provides excellent TypeScript support. With just a few lines of code, we can add persistent state management that feels native to our Unistyles-powered app.

### Installation and Setup

Let’s install StanJS along with MMKV for data persistence:

```bash
yarn add stan-js react-native-mmkv
```

and then regenerate native folders:

```bash
yarn expo prebuild --clean
```

StanJS has built-in MMKV support that makes data persistence effortless.

#### Create the Store

First, let’s set up our store to manage the user’s preferred accent color:

store/store.ts

```tsx
import { Accents } from '@/unistyles'
import { createStore } from 'stan-js'
import { storage } from 'stan-js/storage'


export const { useStore } = createStore({
    preferredAccent: storage<Accents>('banana'),
})
```

The beauty of StanJS lies in its simplicity. To persist data, we just wrap our value in the `storage` helper, which uses MMKV underneath to save the accent preference. StanJS automatically creates a `setPreferredAccent` setter for us - no boilerplate required.

Before we can use our store, we need to create the `Accents` type. Let’s add it to our Unistyles configuration:

unistyles.ts

```tsx
// ... existing imports and theme definitions


 export type Accents = keyof typeof lightTheme['colors']['accents']


type AppBreakpoints = typeof breakpoints
type AppThemes = typeof appThemes


declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes {}
    export interface UnistylesBreakpoints extends AppBreakpoints {}
}


// ... rest of configuration
```

This type gives us powerful type safety - TypeScript will know exactly which accent colors are available and prevent us from using invalid accent names.

Now let’s create a barrel export for our store:

store/index.ts

```tsx
export * from './store'
```

### Connecting the Accent Settings

Now we need to update our accent settings screen to actually save the user’s choice to our store. Currently, it only updates local state that gets lost when the user navigates away.

Let’s update the settings screen to use our StanJS store:

app/settings/settings-accent.tsx

```tsx
import { Button } from '@/components/Button'
import { ThemedText } from '@/components/ThemedText'
 import { useStore } from '@/store'
import { router } from 'expo-router'
import React, { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'


export default function SettingsAccentScreen() {
    const { theme } = useUnistyles()
    const { setPreferredAccent, preferredAccent } = useStore()
    const allAccents = theme.colors.accents
    const [selectedAccent, setSelectedAccent] = useState(preferredAccent)
    const [selectedAccent, setSelectedAccent] = useState('banana')


    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.scrollView}>
                <View style={styles.row}>
                    {Object.entries(allAccents).map(([accentName, accentColor]) => (
                        <Pressable
                            key={accentName}
                            style={styles.item}
                            onPress={() => {
                                setSelectedAccent(accentName as keyof typeof allAccents)
                            }}
                        >
                            <View
                                style={styles.box(accentColor, accentName === selectedAccent)}
                            />
                            <ThemedText bold>
                                {accentName}
                            </ThemedText>
                        </Pressable>
                    ))}
                </View>
            </ScrollView>
            <View style={styles.buttonContainer}>
                <Button
                    label="Save"
                    accent={selectedAccent}
                    onPress={() => {
                        setPreferredAccent(selectedAccent)
                        router.back()
                    }}
                />
            </View>
        </View>
    )
}


// ... styles remain the same
```

Now we’re importing `useStore` from StanJS and accessing both the `preferredAccent` value and the auto-generated `setPreferredAccent` setter. We initialize our local state with the persisted value, and when the user saves their selection, we update the global store before navigating back.

The beautiful thing about this approach is that any other component that listens for the `preferredAccent` value will automatically re-render when the accent preference changes.

### Making Components Dynamic

Now let’s update our components to respond to the user’s accent preference instead of using hardcoded values.

#### Update Button Component

The Button component needs to use the store value as a fallback while still allowing accent overrides:

components/Button.tsx

```tsx
import { Pressable } from 'react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { StyleSheet, UnistylesVariants } from 'react-native-unistyles'
import { useAnimatedVariantColor } from 'react-native-unistyles/reanimated'
import { ThemedText } from './ThemedText'
 import { useStore } from '@/store'


interface ButtonProps extends UnistylesVariants<typeof style> {
    label: string,
    onPress(): void
}


export const Button: React.FunctionComponent<ButtonProps> = ({
    label,
    accent,
    onPress
}) => {
    const { preferredAccent } = useStore()


    style.useVariants({
        accent: accent ?? preferredAccent
        accent: accent
    })


    const color = useAnimatedVariantColor(style.buttonColor, 'backgroundColor')
    const animatedStyle = useAnimatedStyle(() => ({
        backgroundColor: withTiming(color.value, {
            duration: 500
        })
    }))


    return (
        <Pressable onPress={onPress}>
            <Animated.View style={[animatedStyle, style.button]}>
                <ThemedText bold>
                    {label}
                </ThemedText>
            </Animated.View>
        </Pressable>
    )
}


// ... styles remain the same
```

This implementation is flexible - it uses the accent prop if provided (like in the settings preview), but falls back to the user’s preferred accent from the store. This means the “Pick a song” button on the player screen will now use the user’s chosen accent color.

#### Update PlayerControls Component

The PlayerControls component should always use the user’s preferred accent:

components/PlayerControls.tsx

```tsx
import { IconSymbol } from '@/components/ui/IconSymbol'
 import { useStore } from '@/store'
import { Pressable, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import { useUnistyles } from 'react-native-unistyles'


export const PlayerControls = () => {
    const { preferredAccent } = useStore()
    const { theme } = useUnistyles()
    const accent = theme.colors.accents[preferredAccent]
    const accent = theme.colors.accents['banana']


    return (
        <View style={styles.actions}>
            <Pressable>
                <IconSymbol name="backward.end.fill" size={40} color={accent}/>
            </Pressable>
            <Pressable>
                <IconSymbol name="backward.fill" size={50} color={accent}/>
            </Pressable>
            <Pressable>
                <IconSymbol name="play.circle.fill" size={100} color={accent}/>
            </Pressable>
            <Pressable>
                <IconSymbol name="forward.fill" size={50} color={accent}/>
            </Pressable>
            <Pressable>
                <IconSymbol name="forward.end.fill" size={40} color={accent}/>
            </Pressable>
        </View>
    )
}


// ... styles remain the same
```

Now the player controls will dynamically change color based on the user’s accent preference. The StanJS subscription ensures that the component re-renders only when the `preferredAccent` value changes.

We need to remove one more `banana` from `[songId].tsx` screen when there is no selected song:

screens/player/\[songId].tsx

```tsx
import { Button } from '@/components/Button'
import { PlayerControls } from '@/components/PlayerControls'
import { ThemedText } from '@/components/ThemedText'
import { ThemedView } from '@/components/ThemedView'
import { playlist } from '@/mocks'
import { router, useLocalSearchParams } from 'expo-router'
import { Image, ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function PlayerScreen() {
  const { songId } = useLocalSearchParams()


  const song = playlist.find(song => song.id === Number(songId))


  if (!songId || !song) {
    return (
      <ThemedView style={[styles.centerContainer, styles.container]}>
        <ThemedText type="title">
          Looking for inspiration?
        </ThemedText>
        <ThemedText>
          Pick a song from the playlist
        </ThemedText>
        <Button
          label="Pick a song"
          accent="banana"
          onPress={() => router.replace('/')}
        />
      </ThemedView>
    )
  }


// ... rest of the file remains the same
```

### Android

Now let’s test our app on Android to see if there are any platform-specific issues that need addressing.

Running the app on Android, you’ll notice it works correctly overall, but there’s one issue - the TabBar icons are missing! This happens because our `IconSymbol` component uses iOS-specific SF Symbols that don’t exist on Android.

Let’s fix the icon mappings in our `IconSymbol` component:

components/ui/IconSymbol.tsx

```tsx
// ... existing imports and code


const MAPPING = {
  'house.fill': 'home',
  'paperplane.fill': 'send',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.right': 'chevron-right',
  'music.house': 'queue-music',
  'play.circle': 'play-circle-outline',
  'gear.circle': 'settings',
  'backward.end.fill': 'first-page',
  'backward.fill': 'fast-rewind',
  'forward.fill': 'fast-forward',
  'forward.end.fill': 'last-page',
  'play.circle.fill': 'play-circle-filled'
} as IconMapping;


// ... rest of the component
```

These updated mappings use Material Design icons that are available on Android, ensuring our TabBar and player controls display properly across both platforms.

The previous mappings were defaults from the Expo starter template that didn’t match our actual icon usage. With these corrections, your Android app will have proper navigation icons and media controls.

We could also improve the bottom navigation bar by properly configuring `react-native-edge-to-edge` for Android’s gesture navigation, but that’s beyond the scope of this tutorial.

![Android app](/_astro/tutorial-10.M6iz6PRk.jpg)![Android app](/_astro/tutorial-11.GOFOylbE.jpg)

### Web

When you try to run your app on the web, you will encounter a crash:

![Web app](/_astro/tutorial-12.DmmorFmX.png)

This happens because Expo Router uses static rendering by default, and Unistyles needs to be properly initialized for each page during the static rendering process.

To fix this, we need to create a custom HTML root file that ensures Unistyles is initialized correctly:

app/+html.tsx

```tsx
import { ScrollViewStyleReset } from 'expo-router/html'
import { type PropsWithChildren } from 'react'
import '../unistyles'


// This file is web-only and used to configure the root HTML for every
// web page during static rendering.
// The contents of this function only run in Node.js environments and
// do not have access to the DOM or browser APIs.
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />


        {/*
          Disable body scrolling on web. This makes ScrollView components work closer to how they do on native.
          However, body scrolling is often nice to have for mobile web. If you want to enable it, remove this line.
        */}
        <ScrollViewStyleReset />


        {/* Add any additional <head> elements that you want globally available on web... */}
      </head>
      <body>{children}</body>
    </html>
  );
}
```

The key part is the `import '../unistyles'` line at the top - this ensures that Unistyles is initialized before any components try to use it during static rendering.

Note

Read more about Expo Router setup in [this guide](/v3/guides/expo-router).

After adding this file, your app will render correctly on the web! You might notice a few minor issues like the playlist not being scrollable in some browsers or the app accent button being too close to the edge on wide screens, but the core functionality works beautifully.

Before we wrap up this section, let’s explore how Unistyles handles responsive design, a crucial feature for cross-platform apps that also target the web.

### Breakpoints and Media Queries

When your app needs to scale from a phone in your pocket to a large desktop monitor, you face new challenges. Unistyles provides powerful, built-in tools to help you create adaptive and responsive layouts with ease.

The most direct way to create responsive styles is by using **breakpoint objects**. You can turn any style value into an object where the keys are your predefined breakpoint names (`xs`, `sm`, `md`, etc.) and the values are the styles for that specific breakpoint. This enables you to easily create responsive layouts, but only for the properties you need.

Let’s apply this to our `SongTile` component to make the album art larger on bigger screens.

components/SongTile.tsx

```tsx
// ... JSX remains the same


const style = StyleSheet.create(theme => ({
    container: {
        flexDirection: 'row',
        gap: theme.gap(2),
        alignItems: 'center'
    },
    image: {
        width: 80,
        height: 80,
         width: {
             xs: 80,
             md: 120,
             lg: 200
         },
         height: {
             xs: 80,
             md: 120,
             lg: 200
         },
        borderRadius: theme.gap(2)
    },
    textContainer: {
        flex: 1
    }
}))
```

With this change, the width and height of the image will automatically adjust based on the screen width. Unistyles handles the media query logic for you.

![Responsive image](/_astro/tutorial-13.hQUnWpZb.jpg)

Note

Learn more about configuring and using `breakpoints` [here](/v3/references/breakpoints).

For more complex or specific conditions, breakpoint objects might not be enough. This is where the mq (media query) utility shines. It gives you granular control to apply styles based on precise width and height conditions.

Let’s modify our `PlayerScreen` to adopt a more traditional web layout on larger screens - a centered content:

app/(tabs)/player/\[songId].tsx

```tsx
 import { StyleSheet } from 'react-native-unistyles'
 import { mq, StyleSheet } from 'react-native-unistyles'


// ... JSX remains the same


const styles = StyleSheet.create((theme, rt) => ({
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
      },
      container: {
        flex: 1,
        gap: theme.gap(2),
        alignItems: 'center',
        justifyContent: {
            [mq.only.width(600)]: 'center'
        },
        marginTop: rt.insets.top + theme.gap(3),
      },
      image: {
        width: 200,
        height: 200,
        borderRadius: theme.gap(2)
      }
}));
```

Using the `mq` utility, you can target both width and height media queries. Importantly, these are automatically transformed into genuine CSS media queries, which offloads the computations from JavaScript for improved performance.

Note

Dive deeper into the `mq` utility and its helpers [here](/v3/references/media-queries).

### Web styling features

While Unistyles excels at universal styling, there are times you’ll want to leverage platform-specific features. On the web, this often means using CSS pseudo-selectors like `:hover` and `:active` for a more native web experience and better performance.

Unistyles makes this incredibly simple with the `_web` property.

Let’s look at our `SettingTile.tsx` component. On native platforms, a common pattern to handle press states is to provide a function to your style definition, which receives the component’s state.

components/SettingTile.tsx

```tsx
// ... JSX remains the same


const styles = StyleSheet.create({
    container: (state: PressableStateCallbackType) => ({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        opacity: state.pressed ? 0.75 : 1,
    })
})
```

This works perfectly on iOS and Android, but on the web, it relies on JavaScript to update the style. We can achieve a smoother and more performant result by using native CSS pseudo-selectors.

To do this, we’ll modify our container style and add a `_web` key. Inside this `_web` object, we can use special keys like `_hover` and `_active` that Unistyles will automatically convert to CSS pseudo-selectors.

components/SettingTile.tsx

```tsx
const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        opacity: state.pressed ? 0.75 : 1,
        _web: {
            _hover: {
                opacity: 0.75
            },
            _active: {
                opacity: 0.5
            }
        }
    }
})
```

Styles inside the `_web` block will take precedence over the JavaScript-driven opacity logic, replacing it with `_hover` and `_active` selectors.

Now, when you hover over the tile on a web browser, the opacity change is handled entirely by CSS, providing instant feedback.

![Hover effect](/_astro/tutorial-14.1JBIJI7e.png)

This is just the beginning! The `_web` property also allows you to add CSS animations and even target styles using custom class names.

Note

Learn more about all the web-specific features [here](/v3/references/web-only).

### What We’ve Built Together

Congratulations! You’ve built a complete, cross-platform music application that demonstrates the full power of Unistyles 3.0. Let’s recap what we’ve accomplished:

**Core Features:**

* Dynamic theming with light/dark mode support
* Adaptive themes that follow device settings
* Custom accent colors with persistent user preferences
* Cross-platform compatibility (iOS, Android, Web)
* Type-safe styling with complete TypeScript integration

**Unistyles API**

* Theme configuration with custom color palettes and utility functions
* Variants system for dynamic component styling
* Runtime integration for device-aware styling (safe areas, color scheme)
* Dynamic functions for complex style logic
* ScopedTheme for theme previews and isolated theming
* Reanimated integration with smooth accent color transitions
* Performance optimizations with selective re-rendering
* withUnistyles for unsupported props and 3rd party views
* useUnistyles for dynamic subscriptions
* Breakpoints and mq for responsive design
* Web only API for custom web components

**Development Patterns:**

* Merging styles managed by Unistyles and Reanimated
* Component composition with reusable, themed components
* State management with StanJS for clean, persistent user preferences
* Navigation integration with Expo Router and dynamic routes

### Summary

You’ve just completed an incredible journey building a full-featured, cross-platform music application with Unistyles 3.0. From initial configuration to advanced theming and state management.

But most importantly, you’ve learned to think in Unistyles. You understand when to use variants vs dynamic functions, how to leverage the runtime for device-aware styling, and how to build components that are both flexible and maintainable.

This is just the beginning. With the foundation you’ve built, you can now tackle any styling challenge React Native throws your way. Whether it’s complex animations, responsive layouts, or intricate theming systems - you have the tools and knowledge to build beautiful, performant apps that work everywhere.

**Ready for your next project?** Take these patterns and run with them. Build the app you’ve always wanted to create, knowing that Unistyles has your back every step of the way.

Welcome to the future of React Native styling.

[ Previous](/v3/tutorial/player-screens)

[Part 7: Player screens](/v3/tutorial/player-screens)

# Tutorial

> Learn how to build a cross-platform app from scratch with Unistyles 3.0, Expo, and Reanimated

In this `1 hour` long tutorial, we’ll build a simple, cross-platform app that targets `iOS`, `Android`, and `Web`. Our stack will be `Expo`, `Reanimated`, and of course `Unistyles` for powerful, performant styling.

During this tutorial, we will cover most of the Unistyles features and best practices.

![ios app preview](/_astro/tutorial-preview.DH5f69P5.jpg)

### Create new project

First, let’s scaffold a new Expo project using the command line:

```bash
npx create-expo-app@latest unistyles-tutorial
cd unistyles-tutorial
```

Next, install Unistyles, its dependencies, and Reanimated:

```bash
yarn add react-native-reanimated react-native-unistyles react-native-nitro-modules react-native-edge-to-edge
```

Tip

For best results and to ensure compatibility, we recommend using the `react-native-nitro-modules` version specified in the Unistyles [compatibility table](https://github.com/jpudysz/react-native-unistyles?tab=readme-ov-file#installation).

Finally, generate the native project folders required for the app to run:

```bash
yarn expo prebuild --clean
```

### Configure Babel Plugins

Both `Unistyles` and `Reanimated` require a Babel plugin to work. Since a `babel.config.js` file isn’t created by default, we can generate it by running:

```bash
npx expo customize babel.config.js
```

Now, add the `unistyles` and `reanimated` plugins to your `babel.config.js`:

```ts
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
        ['react-native-unistyles/plugin', {
            root: 'app'
        }],
        ['react-native-reanimated/plugin']
    ]
  };
};
```

Tip

To learn more about the Unistyles Babel plugin and its configuration options, check out the [documentation](/v3/other/babel-plugin).

### Modify app entry point

To use features like themes and breakpoints, Unistyles must be configured before your application code runs. This ensures that all stylesheets are created with the correct theme and device context.

First, update your `package.json`:

```json
{
   "main": "expo-router/entry"
   "main": "index.ts"
}
```

Next, create a new `index.ts` file in your project’s root directory. This file will load the standard Expo Router entry point, and then import your Unistyles configuration:

```ts
import 'expo-router/entry'
import './unistyles'
```

We’ll create the `unistyles.ts` file in the next step.

### Configure Unistyles

This is where the magic happens! Create a `unistyles.ts` file in your project’s root. Here, we’ll define our `themes`, `breakpoints`, and register them with Unistyles.

```ts
import { StyleSheet } from 'react-native-unistyles'


const lightTheme = {
    colors: {
        background: '#FCFAF8',
        foreground: '#EDEAE6',
        typography: '#1B140C',
        dimmed: '#ECE8E4',
        tint: '#9A734C',
        activeTint: '#1B140C',
        link: '#1E3799',
        accents: {
            banana: '#F6E58D',
            pumpkin: '#FFBE76',
            apple: '#FF7979',
            grass: '#BADC58',
            storm: '#686DE0'
        }
    },
    gap: (v: number) => v * 8,
} as const


const darkTheme = {
    colors: {
        background: '#221A11',
        foreground: '#332618',
        typography: '#FFFFFF',
        dimmed: '#A8A198',
        tint: '#C9AD92',
        activeTint: '#FFFFFF',
        link: '#0C2461',
        accents: {
            banana: '#f9CA24',
            pumpkin: '#F0932B',
            apple: '#EB4D4B',
            grass: '#6AB04C',
            storm: '#4834D4'
        }
    },
    gap: (v: number) => v * 8,
} as const


const appThemes = {
    light: lightTheme,
    dark: darkTheme
}


const breakpoints = {
    xs: 0,
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200,
}


type AppBreakpoints = typeof breakpoints
type AppThemes = typeof appThemes


declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes {}
    export interface UnistylesBreakpoints extends AppBreakpoints {}
}


StyleSheet.configure({
    settings: {
        adaptiveThemes: true
    },
    themes: {
        light: lightTheme,
        dark: darkTheme,
    },
    breakpoints,
})
```

That’s a lot to take in, so let’s break it down:

**Themes**: We defined light and dark themes. There are no restrictions on a theme’s structure, you can add any properties you need, from colors to spacing functions. In our case we defined a custom palette with different accents and one helper function `gap` for spacing.

**Breakpoints**: We defined a set of breakpoints for responsive design. The only requirement is that one breakpoint must be 0.

**Types**: We extended the Unistyles module with our custom `AppThemes` and `AppBreakpoints` types. This is the key to unlocking full auto-completion and type-safety across your entire app.

**Configuration**: Finally, we called the `StyleSheet.configure` function to set all the options. We also enabled `adaptiveThemes`, which will cause Unistyles to automatically transition between themes based on device color scheme.

Note

To learn more about configuration options, check out the [configuration](/v3/start/configuration) page.

[Next ](/v3/tutorial/cleanup-screens)

[Part 2: Cleanup screens](/v3/tutorial/cleanup-screens)

# Part 6: Modals

> Learn how to build a cross-platform app from scratch with Unistyles 3.0, Expo, and Reanimated

Time to build the modal screens for theme and accent selection. We’ll create interactive components that leverage Unistyles’ powerful theming system and introduce `ScopedTheme` for previewing themes.

### Create SettingOptionRadio Component

Let’s start with a radio button component for selecting theme modes. This component brings together concepts we’ve covered in previous steps.

Create `components/SettingOptionRadio.tsx`:

components/SettingOptionRadio.tsx

```tsx
import { Pressable, PressableStateCallbackType, View } from 'react-native'
import { StyleSheet, type UnistylesVariants } from 'react-native-unistyles'
import { ThemedText } from './ThemedText'


interface SettingOptionRadioProps extends UnistylesVariants<typeof style> {
    label: string,
    onPress(): void
}


export const SettingOptionRadio: React.FunctionComponent<SettingOptionRadioProps> = ({
    label,
    isSelected,
    onPress
}) => {
    style.useVariants({
        isSelected
    })


    return (
        <Pressable
            onPress={onPress}
            style={style.container}
        >
            <ThemedText type="subtitle">
                {label}
            </ThemedText>
            <View style={style.radio}>
                {isSelected && (
                    <View style={style.radioInner} />
                )}
            </View>
        </Pressable>
    )
}


const style = StyleSheet.create(theme => ({
    container: (state: PressableStateCallbackType) => ({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        borderRadius: theme.gap(1),
        padding: theme.gap(2),
        borderWidth: 1,
        borderColor: theme.colors.dimmed,
        opacity: state.pressed ? 0.75 : 1,
    }),
    radio: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 2,
        justifyContent: 'center',
        alignItems: 'center',
        variants: {
            isSelected: {
                true: {
                    borderColor: theme.colors.tint,
                },
                false: {
                    borderColor: theme.colors.dimmed,
                }
            }
        }
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.tint,
    }
}))
```

This component combines everything we’ve learned: `useVariants` for the radio selection state, boolean variants for styling, `PressableStateCallbackType` for press feedback, and `UnistylesVariants` for type safety.

### Basic Theme Settings Screen

Let’s add this component to the theme settings screen:

app/settings/settings-theme.tsx

```tsx
 import { ThemedText } from '@/components/ThemedText'
 import { SettingOptionRadio } from '@/components/SettingOptionRadio'
 import React from 'react'
import { ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function SettingsThemeScreen() {
    return (
        <ScrollView contentContainerStyle={styles.container}>
            <ThemedText type="title">
                Change theme
            </ThemedText>
            <SettingOptionRadio
                label="System"
                isSelected={false}
                onPress={() => {}}
            />
            <SettingOptionRadio
                label="User"
                isSelected={false}
                onPress={() => {}}
            />
        </ScrollView>
    )
}


const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        gap: theme.gap(2),
        paddingTop: theme.gap(2),
        paddingHorizontal: theme.gap(2)
    }
}))
```

### Create ThemeColor Component

Now let’s create a component called `ThemeColor` that will preview different themes.

components/ThemeColor.tsx

```tsx
import { Pressable } from 'react-native'
import { ScopedTheme, StyleSheet, UnistylesThemes } from 'react-native-unistyles'
import { ThemedText } from './ThemedText'


type ThemeColorProps = {
    label: keyof UnistylesThemes,
    onPress: VoidFunction
}


export const ThemeColor: React.FunctionComponent<ThemeColorProps> = ({ label, onPress }) => {
    return (
        <ScopedTheme name={label}>
            <Pressable
                style={styles.container}
                onPress={onPress}
            >
                <ThemedText>
                    {label}
                </ThemedText>
            </Pressable>
        </ScopedTheme>
    )
}


const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        height: 80,
        borderRadius: theme.gap(2),
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.dimmed,
        backgroundColor: theme.colors.background
    }
}))
```

Here’s were things getting interesting. We’ve used new component called `ScopedTheme`.

`ScopedTheme` empowers you to render child components with a specific, **fixed** theme, regardless of the current global app theme. This feature ensures consistent theming in scenarios like theme previews or within specific screens like camera, where a predetermined visual contract is required.

In other words, if you want some of your components to always use a specific theme, you can use `ScopedTheme`.

Note

Explore the [ScopedTheme guide](/v3/references/scoped-theme) to learn about advanced features such as `invertedAdaptive` and the `reset` functionality.

Before proceeding further, notice that we used `keyof UnistylesTheme` (as label type) to ensure type safety. This type represents the keys of all the themes you’ve registered within Unistyles.

### Enhanced Theme Settings Screen

Let’s update the theme settings screen to include theme previews:

app/settings/settings-theme.tsx

```tsx
import { SettingOptionRadio } from '@/components/SettingOptionRadio'
 import { ThemeColor } from '@/components/ThemeColor'
import React from 'react'
 import { ScrollView, View } from 'react-native'
 import { ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function SettingsThemeScreen() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
        <SettingOptionRadio
            label="System"
            isSelected={false}
            onPress={() => {}}
        />
        <SettingOptionRadio
            label="User"
            isSelected={false}
            onPress={() => {}}
        />
       <View style={styles.row}>
           <ThemeColor
               label="light"
               onPress={() => {}}
           />
           <ThemeColor
               label="dark"
               onPress={() => {}}
           />
       </View>
    </ScrollView>
  )
}


const styles = StyleSheet.create(theme => ({
    container: {
        flex: 1,
        gap: theme.gap(2),
        paddingTop: theme.gap(2),
        paddingHorizontal: theme.gap(2)
    },
   row: {
       justifyContent: 'center',
       flexDirection: 'row',
       gap: theme.gap(2)
   }
}))
```

Change your phone’s color scheme and observe that `ScopedTheme` prevents the boxes from re-rendering with the opposite color palette.

![Settings Theme](/_astro/tutorial-6.UAYDoQcv.jpg)

Note

It seems that we need to also update `react-navigation` Header to use Unistyles theme. We will do it before the end of this part of the tutorial.

### Complete Theme Settings Implementation

Now let’s add the full functionality using `UnistylesRuntime` and `useUnistyles`:

app/settings/settings-theme.tsx

```tsx
import { SettingOptionRadio } from '@/components/SettingOptionRadio'
import { ThemeColor } from '@/components/ThemeColor'
import React from 'react'
import { ScrollView, View } from 'react-native'
 import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles'
 import { StyleSheet } from 'react-native-unistyles'


export default function SettingsThemeScreen() {
  const { rt } = useUnistyles()


  return (
    <ScrollView contentContainerStyle={styles.container}>
        <SettingOptionRadio
            label="System"
            isSelected={rt.hasAdaptiveThemes}
            onPress={() => {
              if (rt.hasAdaptiveThemes) {
                return
              }


              UnistylesRuntime.setAdaptiveThemes(true)
            }}
            isSelected={false}
            onPress={() => {}}
        />
        <SettingOptionRadio
            label="User"
            isSelected={!rt.hasAdaptiveThemes}
            onPress={() => {
              if (rt.hasAdaptiveThemes) {
                UnistylesRuntime.setAdaptiveThemes(false)
              }
            }}
            isSelected={false}
            onPress={() => {}}
        />
        {!rt.hasAdaptiveThemes && (
            <View style={styles.row}>
                <ThemeColor
                    label="light"
                    onPress={() => UnistylesRuntime.setTheme('light')}
                    onPress={() => {}}
                />
                <ThemeColor
                    label="dark"
                    onPress={() => UnistylesRuntime.setTheme('dark')}
                    onPress={() => {}}
                />
            </View>
        )}
    </ScrollView>
  )
}
```

Here’s what makes this implementation powerful:

**Using `useUnistyles` for subscriptions**: We use `useUnistyles` to get the `rt` object, which creates a subscription and only re-renders the screen when `hasAdaptiveThemes` changes. Other runtime values won’t trigger unnecessary re-renders.

**Theme management logic**: We can’t change themes when adaptive themes are enabled. Adaptive themes follow the device’s color scheme and automatically switch themes. Allowing manual theme switching would interfere with this system, so we disable theme selection when adaptive themes are active.

**Type-safe theme switching**: `UnistylesRuntime.setTheme()` provides TypeScript hints for all available theme names, making it impossible to set an invalid theme.

Try playing with different settings to see how the app adapts to your choices.

### Update navigation header colors

As you probably noticed, navigation header colors are not updated when theme changes. Let’s fix that by updating `app/(tabs)/settings/_layout.tsx` file:

app/(tabs)/settings/\_layout.tsx

```tsx
import { Stack } from 'expo-router'
import React from 'react'
import { useUnistyles } from 'react-native-unistyles'


export default function SettingsLayout() {
    const { theme } = useUnistyles()


    return (
        <Stack
            screenOptions={{
                headerTitleStyle: {
                    color: theme.colors.typography
                },
                headerStyle: {
                    backgroundColor: theme.colors.background
                },
                contentStyle: {
                    backgroundColor: theme.colors.background
                }
            }}
        >
            <Stack.Screen
                name="index"
                options={{
                    title: 'Settings',
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="settings-theme"
                options={{
                    title: 'Change theme',
                    presentation: 'modal',
                    headerShown: true
                }}
            />
            <Stack.Screen
                name="settings-accent"
                options={{
                    title: 'Change accent',
                    presentation: 'modal',
                    headerShown: true
                }}
            />
        </Stack>
    )
}
```

That’s all for theme settings screen!

### Create Button Component

Now let’s learn something new. We will create an animated button component for the accent settings:

components/Button.tsx

```tsx
import { Pressable } from 'react-native'
import Animated from 'react-native-reanimated'
import { StyleSheet, UnistylesVariants } from 'react-native-unistyles'
import { ThemedText } from './ThemedText'


interface ButtonProps extends UnistylesVariants<typeof style> {
    label: string,
    onPress(): void
}


export const Button: React.FunctionComponent<ButtonProps> = ({
    label,
    accent,
    onPress
}) => {
    style.useVariants({
        accent: accent
    })


    return (
        <Pressable onPress={onPress}>
            <Animated.View style={style.button}>
                <ThemedText bold>
                    {label}
                </ThemedText>
            </Animated.View>
        </Pressable>
    )
}


const style = StyleSheet.create(theme => ({
    button: {
        width: '100%',
        padding: theme.gap(2),
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: theme.gap(1)
    },
    buttonColor: {
        variants: {
            accent: {
                banana: {
                    backgroundColor: theme.colors.accents.banana
                },
                pumpkin: {
                    backgroundColor: theme.colors.accents.pumpkin
                },
                apple: {
                    backgroundColor: theme.colors.accents.apple
                },
                grass: {
                    backgroundColor: theme.colors.accents.grass
                },
                storm: {
                    backgroundColor: theme.colors.accents.storm
                },
                default: {
                    backgroundColor: theme.colors.accents.banana
                }
            }
        }
    }
}))
```

You should be familiar with all the patterns used here: variants, `UnistylesVariants` type, and `useVariants` for dynamic styling. So no extra comment is needed. Let’s add few more lines of code to showcase `Reanimated` integration.

components/Button.tsx

```tsx
import { Pressable } from 'react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { StyleSheet, UnistylesVariants } from 'react-native-unistyles'
 import { useAnimatedVariantColor } from 'react-native-unistyles/reanimated'
import { ThemedText } from './ThemedText'


interface ButtonProps extends UnistylesVariants<typeof style> {
    label: string,
    onPress(): void
}


export const Button: React.FunctionComponent<ButtonProps> = ({
    label,
    accent,
    onPress
}) => {
    style.useVariants({
        accent: accent
    })


    const color = useAnimatedVariantColor(style.buttonColor, 'backgroundColor')
    const animatedStyle = useAnimatedStyle(() => ({
        backgroundColor: withTiming(color.value, {
            duration: 500
        })
    }))


    return (
        <Pressable onPress={onPress}>
            <Animated.View style={style.button}>
            <Animated.View style={[animatedStyle, style.button]}>
                <ThemedText bold>
                    {label}
                </ThemedText>
            </Animated.View>
        </Pressable>
    )
}


// no changes in styles
```

The `useAnimatedVariantColor` hook allows you to reuse Unistyles variants and easily animate them with Reanimated. You simply pass a style that uses variants and select which color property should be animated. TypeScript automatically hints all available color properties.

The hook returns a `SharedValue` from Reanimated, so you’re free to use any animation logic you want. You’ll see this in action in the next section when we implement the accent settings screen.

With just 5 lines of code, we connected Unistyles to Reanimated and animated the button’s background color based on the selected accent variant.

Before moving on, there’s one crucial point: understanding how to merge styles created by Unistyles.

In the `<Animated.View>` component, we used the syntax `[animatedStyle, style.button]` to merge styles. This approach is essential when working with Unistyles. The reason for this specific merging method is that each style managed by Unistyles contains a hidden `JSI NativeState`. This state, stored on the object as an invisible property accessible only via a `Symbol`, is vital for Unistyles’ internal operation. Using the spread operator or other object merging techniques will result in the loss of this state and unpredictable behavior.

For a comprehensive explanation, please refer to our dedicated guide on [Merging styles](/v3/guides/merging-styles).

### Build the Accent Settings Modal

Let’s create the final modal screen for accent selection and animate the accent selection:

app/settings/settings-accent.tsx

```tsx
import { Button } from '@/components/Button'
import { ThemedText } from '@/components/ThemedText'
import { router } from 'expo-router'
import React, { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'


export default function SettingsAccentScreen() {
    const { theme } = useUnistyles()
    const allAccents = theme.colors.accents
    const [selectedAccent, setSelectedAccent] = useState('banana')


    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.scrollView}>
                <View style={styles.row}>
                    {Object.entries(allAccents).map(([accentName, accentColor]) => (
                        <Pressable
                            key={accentName}
                            style={styles.item}
                            onPress={() => {
                                setSelectedAccent(accentName as keyof typeof allAccents)
                            }}
                        >
                            <View style={styles.box(accentColor, accentName === selectedAccent)}/>
                            <ThemedText bold>
                                {accentName}
                            </ThemedText>
                        </Pressable>
                    ))}
                </View>
            </ScrollView>
            <View style={styles.buttonContainer}>
                <Button
                    label="Save"
                    accent={selectedAccent}
                    onPress={() => {
                        router.back()
                    }}
                />
            </View>
        </View>
    )
}


const styles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1
    },
    scrollView: {
        flex: 1,
        gap: theme.gap(2),
        paddingTop: theme.gap(2),
        paddingHorizontal: theme.gap(2)
    },
    box: (accentColor: string, isSelected: boolean) => ({
        height: 40,
        width: 40,
        backgroundColor: accentColor,
        borderRadius: 10,
        borderWidth: isSelected ? 2 : 0,
        borderColor: theme.colors.tint
    }),
    row: {
        flexWrap: 'wrap',
        flexDirection: 'row',
        gap: theme.gap(2)
    },
    item: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.gap(2),
        paddingVertical: theme.gap(2),
        width: '100%',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.dimmed
    },
    buttonContainer: {
        marginBottom: rt.insets.bottom,
        paddingHorizontal: theme.gap(2)
    }
}))
```

This screen uses `useUnistyles` to subscribe to theme changes, allowing us to iterate over all available accent colors. Users can select different accents by tapping the colored boxes, and the selection updates the local state.

The `Button` component animates beautifully thanks to the `useAnimatedVariantColor` hook, with a smooth 500ms transition between different accent colors.

![ios app preview](/_astro/tutorial-7.QJN1tUOL.jpeg)

Perfect! You now have fully functional modal screens that demonstrate the power of Unistyles’ theming system. Users can switch between system and manual theme modes, select different themes, and choose from various accent colors - all with smooth animations and immediate visual feedback.

[ Previous](/v3/tutorial/settings-screen)

[Part 5: Settings screen](/v3/tutorial/settings-screen)

[Next ](/v3/tutorial/player-screens)

[Part 7: Player screens](/v3/tutorial/player-screens)

# Part 4: New screens

> Learn how to build a cross-platform app from scratch with Unistyles 3.0, Expo, and Reanimated

With the initial repository cleanup complete, we’re ready to build the screens for our app.

Our application will feature three primary screens, with the Settings screen also containing two modals:

* **PlaylistScreen**: The main screen to display a list of songs

* **PlayerScreen**: A screen to display the currently playing song

* **SettingsScreen**: A screen with options to customize the app

  * **SettingsThemeScreen**: A modal for changing the app’s theme
  * **SettingsAccentScreen**: A modal for changing the app’s accent color

### PlaylistScreen

First, let’s repurpose the existing `app/(tabs)/index.tsx` file to become our `PlaylistScreen`. This involves changing the component name from `HomeScreen` to `PlaylistScreen` and wrapping the content in a `ScrollView`:

app/(tabs)/index.tsx

```tsx
 import { ScrollView } from 'react-native';
import { ThemedText } from '@/components/ThemedText'
import { ThemedView } from '@/components/ThemedView'
import { StyleSheet } from 'react-native-unistyles'


 export default function PlaylistScreen() {
 export default function HomeScreen() {
  return (
      <ScrollView contentContainerStyle={styles.container}>
      <ThemedView style={styles.container}>
        <ThemedText type="title">
          Home Screen
        </ThemedText>
      </ThemedView>
      </ScrollView>
  );
}


const styles = StyleSheet.create(theme => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  }
}));
```

Next, let’s update the title and adjust the container styles. We’ll remove the centering styles for now, as we want our content to start from the top.

app/(tabs)/index.tsx

```tsx
import { ThemedText } from '@/components/ThemedText'
import { ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function PlaylistScreen() {
  return (
      <ScrollView contentContainerStyle={styles.container}>
        <ThemedText type="title">
          Home Screen
          Playlist
        </ThemedText>
      </ScrollView>
  );
}


const styles = StyleSheet.create(theme => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
```

Oops! We have a problem. Our title has no padding, and the phone’s notch is overlapping it.

![iOS app preview showing title overlapped by notch](/_astro/tutorial-3.B8qsn5Xv.jpeg)

Unistyles to the rescue! We don’t need to rely on any other package or hook to handle this. Remember the `rt` object from `StyleSheet.create`? It contains useful device metadata, including `rt.insets`.

Safe area insets define the portion of the view that is unobscured by system elements like notches or the home indicator. With Unistyles, you have direct access to these values:

* top
* bottom
* left
* right
* ime (an animated inset that changes when the keyboard is shown)

Let’s use `rt.insets.top` to add a top margin to our container, pushing the content below the notch:

app/(tabs)/index.tsx

```tsx
 const styles = StyleSheet.create((theme, rt) => ({
 const styles = StyleSheet.create(theme => ({
  container: {
    flex: 1,
    marginTop: rt.insets.top,
  },
}));
```

To give our content some breathing room, let’s also add horizontal padding using our theme’s spacing system:

app/(tabs)/index.tsx

```tsx
 const styles = StyleSheet.create((theme, rt) => ({
  container: {
    flex: 1,
    marginTop: rt.insets.top,
    paddingHorizontal: theme.gap(2),
  },
}));
```

### PlayerScreen

For the `PlayerScreen`, we’ll start by creating a new file structure and then use a modified version of our `PlaylistScreen` code.

Expo Router uses a file-based routing system. To create a dynamic route for our player, create the following folder and file:

* app/

  * (tabs)/

    * player/

      * \[songId].tsx

    * \_layout.tsx

    * index.tsx

  * \_layout.tsx

  * +not-found.tsx

Now, populate `app/(tabs)/player/[songId].tsx` with the following code. It’s very similar to `PlaylistScreen`, but with the title changed to “Player”.

app/(tabs)/player/\[songId].tsx

```tsx
import { ThemedText } from '@/components/ThemedText'
import { ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function PlayerScreen() {
    return (
        <ScrollView contentContainerStyle={styles.container}>
            <ThemedText type="title">
                Player
            </ThemedText>
        </ScrollView>
    );
}


const styles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        marginTop: rt.insets.top,
        paddingHorizontal: theme.gap(2)
    },
}));
```

Note

Don’t worry about the TabBar icons and routing just yet - we’ll fix that soon!

### SettingsScreen

The `SettingsScreen` is our final main screen. It will serve as a hub for navigating to the modal screens where users can change the app’s theme and accent color.

First, set up the required files and folders:

* app/

  * settings/

    * \_layout.tsx
    * index.tsx
    * settings-theme.tsx
    * settings-accent.tsx

  * (tabs)/

    * player/

      * \[songId].tsx

    * \_layout.tsx

    * index.tsx

  * \_layout.tsx

  * +not-found.tsx

This is a standard Expo Router stack layout. Let’s add the code for each of these new files.

#### 1. Configure the Stack Navigator (\_layout.tsx)

This file configures the stack navigator for the settings section, defining the main screen and the two modal screens.

app/settings/\_layout.tsx

```tsx
import { Stack } from 'expo-router'
import React from 'react'
import { useUnistyles } from 'react-native-unistyles'


export default function SettingsLayout() {
    const { theme } = useUnistyles()


    return (
        <Stack
            screenOptions={{
                contentStyle: {
                    backgroundColor: theme.colors.background
                }
            }}
        >
            <Stack.Screen
                name="index"
                options={{
                    title: 'Settings',
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="settings-theme"
                options={{
                    title: 'Change theme',
                    presentation: 'modal',
                    headerShown: true
                }}
            />
            <Stack.Screen
                name="settings-accent"
                options={{
                    title: 'Change accent',
                    presentation: 'modal',
                    headerShown: true
                }}
            />
        </Stack>
    )
}
```

#### 2. Create the Main Settings Screen (index.tsx)

This is the main `SettingsScreen`. The code is almost identical to our other screens for now.

app/settings/index.tsx

```tsx
import { ThemedText } from '@/components/ThemedText'
import { ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function SettingsScreen() {
    return (
        <ScrollView contentContainerStyle={styles.container}>
            <ThemedText type="title">
                Settings
            </ThemedText>
        </ScrollView>
    );
}


const styles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        marginTop: rt.insets.top,
        paddingHorizontal: theme.gap(2)
    },
}));
```

#### 3. Create the Modal Screens

The modal screens for changing the theme and accent color are also simple placeholders. Notice the component names and titles are updated for each.

app/settings/settings-theme.tsx

```tsx
import { ThemedText } from '@/components/ThemedText'
import { ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function SettingsThemeScreen() {
    return (
        <ScrollView contentContainerStyle={styles.container}>
            <ThemedText type="title">
                Change theme
            </ThemedText>
        </ScrollView>
    );
}


const styles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        marginTop: rt.insets.top,
        paddingHorizontal: theme.gap(2)
    },
}));
```

app/settings/settings-accent.tsx

```tsx
import { ThemedText } from '@/components/ThemedText'
import { ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function SettingsAccentScreen() {
    return (
        <ScrollView contentContainerStyle={styles.container}>
            <ThemedText type="title">
                Change accent
            </ThemedText>
        </ScrollView>
    );
}


const styles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        marginTop: rt.insets.top,
        paddingHorizontal: theme.gap(2)
    },
}));
```

You should now be able to navigate to all three screens, each with a different title but the same basic layout.

### TabBar

Currently, `TabBar` doesn’t reflect our new screen structure. Let’s update `app/(tabs)/_layout.tsx` to correctly register our routes and assign new icons.

app/(tabs)/\_layout.tsx

```tsx
import { IconSymbol } from '@/components/ui/IconSymbol'
import { Tabs } from 'expo-router'
import React from 'react'
import { useUnistyles } from 'react-native-unistyles'


export default function TabLayout() {
  const { theme } = useUnistyles()


  return (
    <Tabs
      screenOptions={{
        tabBarInactiveTintColor: theme.colors.tint,
        tabBarActiveTintColor: theme.colors.activeTint,
        sceneStyle: {
          backgroundColor: theme.colors.background
        },
        tabBarStyle: {
          backgroundColor: theme.colors.foreground
        },
        headerShown: false
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          title: 'Playlist',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="music.house" color={color} />,
        }}
      />
      <Tabs.Screen
        name="player/[songId]"
        options={{
          title: 'Player',
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="play.circle" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        name="settings"
        options={{
          title: 'Explore',
          title: 'Settings',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="paperplane.fill" color={color} />,
          tabBarIcon: ({ color }) => <IconSymbol size={24} name="gear.circle" color={color} />,
        }}
      />
    </Tabs>
  );
}
```

Congratulations! You’ve successfully set up the basic screen structure and navigation for the app. The boilerplate is out of the way, and we’re ready to start bringing the designs to life in the next part!

![iOS app preview showing playlist screen](/_astro/tutorial-4.CB-XZtXx.jpeg)

[ Previous](/v3/tutorial/cleanup-components)

[Part 3: Cleanup components](/v3/tutorial/cleanup-components)

[Next ](/v3/tutorial/settings-screen)

[Part 5: Settings screen](/v3/tutorial/settings-screen)

# Part 7: Player screens

> Learn how to build a cross-platform app from scratch with Unistyles 3.0, Expo, and Reanimated

Now that we have our settings system in place, it’s time to build the heart of our music app - the playlist and player screens. We’ll create a complete music browsing experience with proper TypeScript types, mock data, and dynamic navigation between screens.

By the end of this part, you’ll have a functional music app that displays a list of songs and allows users to navigate to a detailed player view for each track.

### Setting Up Types and Mock Data

Before we can build our screens, we need to establish the data structure for our songs. This step is crucial for maintaining type safety throughout our application and ensuring that our components receive the expected data format.

Let’s start by creating the fundamental types that will power our music app.

#### Create Song Types

First, we’ll define what a song looks like in our application. Each song needs essential information like title, genre, cover image, and duration.

Create `types/song.ts`:

types/song.ts

```tsx
export type Song = {
    id: number,
    title: string,
    genre: string,
    imageUrl: string,
    duration: string
}


export type Playlist = Array<Song>
```

Now let’s create an index file to make imports cleaner throughout our app.

Create `types/index.ts`:

types/index.ts

```tsx
export * from './song'
```

#### Create Mock Playlist Data

For this tutorial, we’ll use a curated list of 20 fictional songs with diverse genres to showcase our app’s capabilities. In a real application, this data would come from an API or music service.

Create `mocks/playlist.ts`:

mocks/playlist.ts

```tsx
import { Playlist } from '@/types'


export const playlist: Playlist = [
  {
    "id": 1,
    "title": "Midnight Bloom",
    "genre": "Dream Pop",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "03:42"
  },
  {
    "id": 2,
    "title": "Neon Skyline Drive",
    "genre": "Synthwave",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "04:15"
  },
  {
    "id": 3,
    "title": "Forgotten Lullaby",
    "genre": "Indie Folk",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "02:58"
  },
  {
    "id": 4,
    "title": "Electric Serenade",
    "genre": "Electropop",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "03:21"
  },
  {
    "id": 5,
    "title": "Crimson Tide Rhapsody",
    "genre": "Orchestral Rock",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "04:55"
  },
  {
    "id": 6,
    "title": "Static Echo Chamber",
    "genre": "Noise Rock",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "02:30"
  },
  {
    "id": 7,
    "title": "Whispers in the Algorithm",
    "genre": "Glitch Hop",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "03:50"
  },
  {
    "id": 8,
    "title": "Galactic Ballroom Blitz",
    "genre": "Space Disco",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "04:38"
  },
  {
    "id": 9,
    "title": "Shadows of Yesterday",
    "genre": "Gothic Rock",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "02:45"
  },
  {
    "id": 10,
    "title": "Renegade Heartbeat",
    "genre": "Punk Rock",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "02:45"
  },
  {
    "id": 11,
    "title": "Emerald City Blues",
    "genre": "Jazz Fusion",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "04:05"
  },
  {
    "id": 12,
    "title": "Lunar Labyrinth",
    "genre": "Ambient Techno",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "05:00"
  },
  {
    "id": 13,
    "title": "Stone Cold Symphony",
    "genre": "Hard Rock",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "03:33"
  },
  {
    "id": 14,
    "title": "Celestial Caravan",
    "genre": "World Music",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "04:22"
  },
  {
    "id": 15,
    "title": "Velvet Revolution",
    "genre": "Soul",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "02:17"
  },
  {
    "id": 16,
    "title": "Binary Sunset Dreams",
    "genre": "Chillwave",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "03:08"
  },
  {
    "id": 17,
    "title": "Rusted Gears and Broken Hearts",
    "genre": "Industrial",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "04:48"
  },
  {
    "id": 18,
    "title": "Sapphire Rain Dance",
    "genre": "Trance",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "02:51"
  },
  {
    "id": 19,
    "title": "Concrete Jungle Ballad",
    "genre": "Hip Hop",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "03:19"
  },
  {
    "id": 20,
    "title": "Infinite Horizons Calling",
    "genre": "Progressive Metal",
    "imageUrl": "https://picsum.photos/200/300",
    "duration": "04:30"
  }
]
```

We’re using placeholder images from Picsum Photos, which provides random images perfect for mockups. Each song has a unique ID that we’ll use for navigation, and the variety of genres will help showcase how our components handle different types of content.

Create the barrel export for mocks:

mocks/index.ts

```tsx
export * from './playlist'
```

This gives us clean access to our mock data throughout the application with simple imports.

### Building the Playlist Screen

Now that we have our data structure in place, let’s transform the placeholder home screen into a proper playlist that displays our collection of songs. The playlist will serve as the main entry point where users can browse and select tracks.

Currently, our home screen at `app/(tabs)/index.tsx` just displays a simple title. We need to replace this with a scrollable list of songs that users can interact with.

Let’s update the playlist screen to display our songs:

app/(tabs)/index.tsx

```tsx
 import { SongTile } from '@/components/SongTile'
import { ThemedText } from '@/components/ThemedText'
 import { playlist } from '@/mocks'
 import { router } from 'expo-router'
 import { ScrollView, View } from 'react-native'
 import { ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function PlaylistScreen() {
  return (
     <View style={styles.container}>
         <ScrollView contentContainerStyle={styles.contentContainer}>
           <View style={styles.header}>
             <ThemedText type="title">
               Playlist
             </ThemedText>
           </View>
           {playlist.map(song => (
             <SongTile
               song={song}
               onPress={() => router.push(`/(tabs)/player/${song.id}`)}
               key={song.id}
             />
           ))}
       </ScrollView>
     </View>
     <ScrollView contentContainerStyle={styles.container}>
       <ThemedText type="title">
         Playlist
       </ThemedText>
     </ScrollView>
  );
}


 const styles = StyleSheet.create((theme, rt) => ({
   container: {
     marginTop: rt.insets.top + theme.gap(3),
     backgroundColor: theme.colors.background
   },
   contentContainer: {
     gap: theme.gap(3),
     paddingHorizontal: theme.gap(2)
   },
   header: {
     paddingBottom: theme.gap(2)
   }
 }));
 const styles = StyleSheet.create((theme, rt) => ({
   container: {
     flex: 1,
     marginTop: rt.insets.top,
     paddingHorizontal: theme.gap(2)
   },
 }));
```

Here’s what we’ve changed and why:

**Layout structure**: We now use a `View` container with a `ScrollView` inside, rather than just a `ScrollView`. This gives us better control over the layout and background colors.

**Data integration**: We’re mapping over our playlist array to create a `SongTile` for each song. This approach is scalable and will automatically adapt if we add or remove songs from our playlist.

**Navigation logic**: Each `SongTile` receives an `onPress` callback that navigates to the player screen with the specific song ID. We’re using Expo Router’s dynamic routing with the pattern `/(tabs)/player/${song.id}`.

**Styling considerations**: Notice that we don’t need to wrap the `ScrollView` with `withUnistyles` this time. Unlike in the settings screen, we’re not using any dynamic styles in the `contentContainer` style that need to react to theme changes - just static spacing and padding values.

The key difference is that we’re now structuring our app to handle a list of data items, each with its own navigation destination.

### Creating the SongTile Component

The `SongTile` component will be responsible for displaying individual song information in an attractive, tappable format. This component needs to show the song’s cover art, title, genre, and duration in a clean layout.

Before our playlist screen can work, we need to create the `SongTile` component that will display each song:

components/SongTile.tsx

```tsx
import { Song } from '@/types'
import { Image, Pressable, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import { ThemedText } from './ThemedText'


type SongProps = {
    song: Song,
    onPress(): void
}


export const SongTile: React.FunctionComponent<SongProps> = ({ song, onPress }) => {
    return (
        <Pressable style={style.container} onPress={onPress}>
            <Image
                source={{ uri: song.imageUrl }}
                style={style.image}
            />
            <View style={style.textContainer}>
                <ThemedText bold>
                    {song.title}
                </ThemedText>
                <ThemedText dimmed>
                    {song.genre}
                </ThemedText>
            </View>
            <ThemedText>
                {song.duration}
            </ThemedText>
        </Pressable>
    )
}


const style = StyleSheet.create(theme => ({
    container: {
        flexDirection: 'row',
        gap: theme.gap(2),
        alignItems: 'center'
    },
    image: {
        width: 80,
        height: 80,
        borderRadius: theme.gap(2)
    },
    textContainer: {
        flex: 1
    }
}))
```

This component follows the patterns we’ve established throughout the tutorial and you should understand it fully.

![iOS app preview showing playlist screen](/_astro/tutorial-8.BcUZ_tQ3.jpg)

We now have a fully functional playlist screen that displays our 20 mock songs in an attractive list format. Each song shows its cover art, title, genre, and duration. Tapping any song will navigate to the player screen with that specific song’s ID. Screen properly handles safe areas and maintains our app’s theme consistency.

### Building the Player Screen

The player screen needs to handle dynamic routing, where the song ID comes from the URL parameter. This screen will display detailed information about the selected song and provide playback controls.

Let’s update our player screen at `app/(tabs)/player/[songId].tsx` to handle the dynamic song data:

app/(tabs)/player/\[songId].tsx

```tsx
 import { Button } from '@/components/Button'
 import { PlayerControls } from '@/components/PlayerControls'
import { ThemedText } from '@/components/ThemedText'
 import { ThemedView } from '@/components/ThemedView'
 import { playlist } from '@/mocks'
 import { router, useLocalSearchParams } from 'expo-router'
 import { Image, ScrollView } from 'react-native'
 import { ScrollView } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'


export default function PlayerScreen() {
   const { songId } = useLocalSearchParams()


   const song = playlist.find(song => song.id === Number(songId))


   if (!songId || !song) {
     return (
       <ThemedView style={[styles.centerContainer, styles.container]}>
         <ThemedText type="title">
           Looking for inspiration?
         </ThemedText>
         <ThemedText>
           Pick a song from the playlist
         </ThemedText>
         <Button
           label="Pick a song"
           accent="banana"
           onPress={() => router.replace('/')}
         />
       </ThemedView>
     )
   }


  return (
     <ScrollView contentContainerStyle={styles.container}>
       <Image
         source={{ uri: song.imageUrl }}
         style={styles.image}
       />
       <ThemedText type="title">
         {song.title}
       </ThemedText>
       <ThemedText dimmed type="subtitle">
         {song.genre}
       </ThemedText>
       <ThemedText>
         {song.duration}
       </ThemedText>
       <PlayerControls />
     </ScrollView>
     <ScrollView contentContainerStyle={styles.container}>
       <ThemedText type="title">
         Player
       </ThemedText>
     </ScrollView>
  );
}


 const styles = StyleSheet.create((theme, rt) => ({
   centerContainer: {
     flex: 1,
     justifyContent: 'center',
     alignItems: 'center'
   },
   container: {
     flex: 1,
     gap: theme.gap(2),
     alignItems: 'center',
     marginTop: rt.insets.top + theme.gap(3),
   },
   image: {
     width: 200,
     height: 200,
     borderRadius: theme.gap(2)
   }
 }));
 const styles = StyleSheet.create((theme, rt) => ({
   container: {
     flex: 1,
     marginTop: rt.insets.top,
     paddingHorizontal: theme.gap(2)
   },
 }));
```

We use `useLocalSearchParams()` to extract the `songId` from the URL. This allows users to navigate directly to any song or bookmark specific tracks.

Notice the `Button` component uses the hardcoded “banana” accent. In the next part of the tutorial, we’ll make this dynamic based on the user’s accent preferences from the settings screen.

Our screen still needs one more component to be complete - the `PlayerControls`.

### Creating the PlayerControls Component

The player controls provide the interface for music playback. While they won’t actually play music in this tutorial, they give users the familiar media controls they expect in a music app.

Let’s create the final component for our player interface:

components/PlayerControls.tsx

```tsx
import { IconSymbol } from '@/components/ui/IconSymbol'
import { Pressable, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import { useUnistyles } from 'react-native-unistyles'


export const PlayerControls = () => {
    const { theme } = useUnistyles()
    const accent = theme.colors.accents['banana']


    return (
        <View style={styles.actions}>
            <Pressable>
                <IconSymbol name="backward.end.fill" size={40} color={accent}/>
            </Pressable>
            <Pressable>
                <IconSymbol name="backward.fill" size={50} color={accent}/>
            </Pressable>
            <Pressable>
                <IconSymbol name="play.circle.fill" size={100} color={accent}/>
            </Pressable>
            <Pressable>
                <IconSymbol name="forward.fill" size={50} color={accent}/>
            </Pressable>
            <Pressable>
                <IconSymbol name="forward.end.fill" size={40} color={accent}/>
            </Pressable>
        </View>
    )
}


const styles = StyleSheet.create(theme => ({
    actions: {
        marginTop: theme.gap(2),
        flexDirection: 'row',
        gap: theme.gap(2),
        alignItems: 'center'
    }
}))
```

Like the Button component, we’re currently using the hardcoded “banana” accent color.

![iOS app preview showing player screen](/_astro/tutorial-9.EDWNowzr.jpg)

Perfect! You now have a complete music player interface that demonstrates many of Unistyles’ capabilities. Users can browse a playlist of songs, tap to navigate to individual tracks, and see a detailed player interface with media controls. The app maintains consistent theming throughout and handles navigation gracefully.

The hardcoded “banana” accent colors in both the `Button` and `PlayerControls` components are intentional placeholders. In the final part of our tutorial, we’ll connect these to the user’s accent preferences from the settings screen, making the entire app truly dynamic and personalized.

[ Previous](/v3/tutorial/modals)

[Part 6: Modals](/v3/tutorial/modals)

[Next ](/v3/tutorial/cross-platform)

[Part 8: Cross-platform](/v3/tutorial/cross-platform)

# Part 5: Settings screen

> Learn how to build a cross-platform app from scratch with Unistyles 3.0, Expo, and Reanimated

Time to bring our settings screen to life! We’ll create a beautiful settings interface that showcases how Unistyles integrates seamlessly with React Native’s `Pressable` component and explore the difference between `UnistylesRuntime` and the `rt` object.

Our settings screen will feature interactive tiles that users can tap to modify the app’s appearance.

### Create the SettingTile Component

Let’s start by creating a reusable `SettingTile` component. This component will demonstrate one of Unistyles’ coolest features: zero-config integration with `Pressable` and `PressableStateCallbackType`.

Create a new file `components/SettingTile.tsx`:

components/SettingTile.tsx

```tsx
import { Pressable, PressableStateCallbackType, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import { ThemedText } from './ThemedText'


type SettingTileProps = {
    settingName: string,
    selectedValue: string,
    description: string,
    onPress(): void
}


export const SettingTile: React.FunctionComponent<SettingTileProps> = ({
    settingName,
    selectedValue,
    description,
    onPress
}) => {
    return (
        <Pressable
            style={styles.container}
            onPress={onPress}
        >
            <View>
                <ThemedText bold>
                    {settingName}
                </ThemedText>
                <ThemedText dimmed>
                    {description}
                </ThemedText>
            </View>
            <ThemedText>
                {selectedValue}
            </ThemedText>
        </Pressable>
    )
}


const styles = StyleSheet.create({
    container: (state: PressableStateCallbackType) => ({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        opacity: state.pressed ? 0.75 : 1,
    })
})
```

This is where Unistyles really shines! Notice how we pass the `PressableStateCallbackType` directly to our style function. **No extra configuration needed** - Unistyles automatically recognizes that this style depends on the pressable state and handles all the complexity for you.

When you press the tile, the opacity changes from `1` to `0.75`, giving users immediate visual feedback.

### Enhance ThemedText with Variants

You might have noticed we’re using `bold` and `dimmed` props on `ThemedText` that don’t exist yet. Let’s add them using Unistyles variants.

Update your `ThemedText` component:

components/ThemedText.tsx

```tsx
import { Text, type TextProps } from 'react-native'
import { StyleSheet, type UnistylesVariants } from 'react-native-unistyles'


export type ThemedTextProps = TextProps & UnistylesVariants<typeof styles>


export function ThemedText({
  style,
  type,
  bold,
  dimmed,
  ...rest
}: ThemedTextProps) {
  styles.useVariants({
    type,
    bold,
    dimmed
  })


  return (
    <Text
      style={[
        styles.textColor,
        styles.textType,
        style,
      ]}
      {...rest}
    />
  );
}


const styles = StyleSheet.create(theme => ({
  textColor: {
    color: theme.colors.typography
  },
  textType: {
    variants: {
      type: {
        default: {
          fontSize: 16,
          lineHeight: 24,
        },
        title: {
          fontSize: 32,
          fontWeight: 'bold',
          lineHeight: 32,
        },
        subtitle: {
          fontSize: 20
        },
        link: {
          lineHeight: 30,
          fontSize: 16,
          color: '#0a7ea4',
        },
      },
      bold: {
        true: {
          fontWeight: 'bold',
        }
      },
      dimmed: {
        true: {
          color: theme.colors.tint
        }
      }
    }
  }
}));
```

**Boolean variants** are incredibly powerful. Unityles supports variants with boolean values like `true` and `false` that can be easily mapped from props.

This pattern makes your components more readable and eliminates the need for multiple style objects or conditional logic in your JSX.

### Build the Settings Interface

Now let’s implement the actual settings screen with our new `SettingTile` component.

Update your `app/settings/index.tsx`:

app/settings/index.tsx

```tsx
 import { SettingTile } from '@/components/SettingTile'
import { ThemedText } from '@/components/ThemedText'
 import { ScrollView, View } from 'react-native'
 import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles'
 import { ScrollView } from 'react-native'
 import { StyleSheet } from 'react-native-unistyles'


export default function SettingsScreen() {
   const systemTheme = UnistylesRuntime.hasAdaptiveThemes


    return (
       <ScrollView contentContainerStyle={styles.container}>
       <ScrollView contentContainerStyle={styles.scrollView}>
            <ThemedText type="title">
               Settings
               Appearance
            </ThemedText>
           <View style={styles.settingsContainer}>
               <SettingTile
                   settingName="Theme"
                   selectedValue="Light"
                   description={systemTheme ? 'System' : 'User'}
                   onPress={() => {}}
               />
               <SettingTile
                   settingName="App accent"
                   selectedValue="Default"
                   description="Primary app color"
                   onPress={() => {}}
               />
           </View>
        </ScrollView>
    );
}


 const styles = StyleSheet.create((theme, rt) => ({
     scrollView: {
         marginTop: rt.insets.top + theme.gap(3),
         backgroundColor: theme.colors.background,
         paddingHorizontal: theme.gap(2)
     },
     settingsContainer: {
         marginTop: theme.gap(4),
         gap: theme.gap(4)
     },
 }));
 const styles = StyleSheet.create((theme, rt) => ({
     container: {
         flex: 1,
         marginTop: rt.insets.top,
         paddingHorizontal: theme.gap(2)
     },
 }));
```

### UnistylesRuntime vs rt Object

Here’s where things get interesting. Notice we’re using `UnistylesRuntime.hasAdaptiveThemes` instead of accessing it through `rt`.

**What’s the difference?**

* **`rt` (mini runtime)**: is only available inside `StyleSheet.create()` function or `useUnistyles` hook. It contains device metadata like insets, screen dimensions, and color scheme that are relevant for styling

* **`UnistylesRuntime`**: A global object accessible **anywhere** in your app, not just in stylesheets or components. It contains all the same information as `rt` plus additional methods (setters)

The key difference is that `UnistylesRuntime` is **not a hook** - it won’t cause your component to re-render when values change. This is by design for performance reasons.

If you need your component to re-render when runtime values change, you should use the `useUnistyles` hook instead:

```tsx
// This will not re-render when runtime changes
const isSystemTheme = UnistylesRuntime.hasAdaptiveThemes


// This will re-render when runtime changes
const { rt } = useUnistyles()
```

Note

Learn more about `UnistylesRuntime` in the [dedicated guide](/v3/references/unistyles-runtime).

### ScrollView Background Issue

Try switching between light and dark themes in your app. You’ll notice something odd - the `ScrollView` background color doesn’t update! This is because `contentContainerStyle` is not a regular style prop that Unistyles can automatically track.

For such cases we created `withUnistyles` higher-order component (HOC) that allows you to wrap any component and automatically re-render it, depending on it’s dependencies.

Note

For views that either don’t use the `style` prop or aren’t React Native components, you can use the `withUnistyles` HOC. Check out the [withUnistyles guide](/v3/references/with-unistyles) for more details on when and how to use it.

In order to update background color of `ScrollView`, we need to wrap it with `withUnistyles`:

app/settings/index.tsx

```tsx
import { SettingTile } from '@/components/SettingTile'
import { ThemedText } from '@/components/ThemedText'
import { ScrollView, View } from 'react-native'
 import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles'
 import { StyleSheet, UnistylesRuntime, withUnistyles } from 'react-native-unistyles'


 const StyledScrollView = withUnistyles(ScrollView)


export default function SettingsScreen() {
    const systemTheme = UnistylesRuntime.hasAdaptiveThemes


    return (
        <ScrollView contentContainerStyle={styles.scrollView}>
        <StyledScrollView contentContainerStyle={styles.scrollView}>
            <ThemedText type="title">
                Appearance
            </ThemedText>
            <View style={styles.settingsContainer}>
                <SettingTile
                    settingName="Theme"
                    selectedValue="Light"
                    description={systemTheme ? 'System' : 'User'}
                    onPress={() => {}}
                />
                <SettingTile
                    settingName="App accent"
                    selectedValue="Default"
                    description="Primary app color"
                    onPress={() => {}}
                />
            </View>
        </ScrollView>
        </StyledScrollView>
    );
}


const styles = StyleSheet.create((theme, rt) => ({
    scrollView: {
        marginTop: rt.insets.top + theme.gap(3),
        backgroundColor: theme.colors.background,
        paddingHorizontal: theme.gap(2)
    },
    settingsContainer: {
        marginTop: theme.gap(4),
        gap: theme.gap(4)
    },
}));
```

That’s it! No additional mappings are required in `withUnistyles` as `contentContainerStyle` is handled automatically.

Remember these key points about `withUnistyles`:

* It intelligently re-renders your component only when its style dependencies change, optimizing performance
* It accepts a mapping function as a second argument, allowing you to map `theme` or `rt` values to the component’s props

### Add Modal Navigation

Finally, let’s wire up the `onPress` callbacks to navigate to our modal screens:

app/settings/index.tsx

```tsx
import { SettingTile } from '@/components/SettingTile'
import { ThemedText } from '@/components/ThemedText'
import { ScrollView, View } from 'react-native'
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles'
 import { router } from 'expo-router'


const StyledScrollView = withUnistyles(ScrollView)


export default function SettingsScreen() {
    const systemTheme = UnistylesRuntime.hasAdaptiveThemes


    return (
        <StyledScrollView contentContainerStyle={styles.scrollView}>
            <ThemedText type="title">
                Appearance
            </ThemedText>
            <View style={styles.settingsContainer}>
                <SettingTile
                    settingName="Theme"
                    selectedValue="Light"
                    description={systemTheme ? "System" : 'User'}
                   onPress={() => {}}
                   onPress={() => router.push('/(tabs)/settings/settings-theme')}
                />
                <SettingTile
                    settingName="App accent"
                    selectedValue="Default"
                    description="Primary app color"
                   onPress={() => {}}
                   onPress={() => router.push('/(tabs)/settings/settings-accent')}
                />
            </View>
        </StyledScrollView>
    );
}
```

![ios app preview](/_astro/tutorial-5.DuVD56lx.jpeg)

Perfect! Your settings screen now has interactive tiles that provide immediate visual feedback and navigate to the appropriate modal screens. In the next part, we’ll implement the functionality for these modals and show how to dynamically update themes and accent colors.

[ Previous](/v3/tutorial/new-screens)

[Part 4: New screens](/v3/tutorial/new-screens)

[Next ](/v3/tutorial/modals)

[Part 6: Modals](/v3/tutorial/modals)