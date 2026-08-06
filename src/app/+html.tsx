// Learn more https://docs.expo.dev/router/reference/static-rendering/#root-html

import { ScrollViewStyleReset, useServerDocumentContext } from 'expo-router/html'

// This file is web-only and used to configure the root HTML for every
// web page during static rendering.
// The contents of this function only run in Node.js environments and
// do not have access to the DOM or browser APIs.
export default function Root({ children }: { children: React.ReactNode }) {
  // This is only required for server-side rendering.
  const { bodyAttributes, bodyNodes, htmlAttributes, headNodes } = useServerDocumentContext()

  return (
    <html lang="en" {...htmlAttributes}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/* RC, real device: "every time I click it [the pencil/circle
            annotate tool] to circle things for you, it blows the screen up
            huge and I can't edit." Expo Router's own default viewport tag
            (see node_modules/expo/.../@expo/cli/static/template/+html.tsx)
            never set maximum-scale, so WebKit's double-tap-to-zoom gesture
            was fully live on every page -- a quick double-tap-style
            interaction (exactly what drawing/circling on a screenshot
            involves) reads as "zoom in" with nothing capping how far, which
            matches "blows up huge" precisely. maximum-scale=1 caps zoom-in
            at 100% (nothing left to zoom to, so double-tap-zoom is a no-op)
            without touching pinch-zoom-out, which stays available. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no" />

        {/*
          Disable body scrolling on web. This makes ScrollView components work closer to how they do on native.
          However, body scrolling is often nice to have for mobile web. If you want to enable it, remove this line.
        */}
        <ScrollViewStyleReset />

        {headNodes}

        {/* Add any additional <head> elements that you want globally available on web... */}
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  )
}
