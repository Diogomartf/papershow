// The smallest JSX runtime satori needs: elements are plain { type, props } objects.
// Lets apps be written as JSX without shipping React to the server.

export type Node = { type: string | Component; props: Props; key?: string | number | null } | string | number | boolean | null | undefined | Node[];
type Props = { children?: Node; style?: Record<string, unknown>; [k: string]: unknown };
type Component = (props: Props) => Node;

export function jsx(type: string | Component, props: Props, key?: string | number) {
  // satori expands strings itself, but not function components.
  if (typeof type === "function") return type(props);
  return { type, props, key: key ?? null };
}
export const jsxs = jsx;
export const Fragment = ({ children }: Props) => children;

export namespace JSX {
  export type Element = Node;
  export interface IntrinsicElements {
    [tag: string]: Props;
  }
  export interface ElementChildrenAttribute {
    children: unknown;
  }
}
