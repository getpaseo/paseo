import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import type { PluggableList } from "unified";

export const docsRehypePlugins: PluggableList = [
  rehypeSlug,
  [
    rehypeAutolinkHeadings,
    {
      behavior: "prepend",
      properties: { className: "heading-anchor", ariaLabel: "Link to this section" },
      content: {
        type: "element",
        tagName: "span",
        properties: { className: "heading-anchor-icon", ariaHidden: "true" },
        children: [{ type: "text", value: "#" }],
      },
    },
  ],
];
