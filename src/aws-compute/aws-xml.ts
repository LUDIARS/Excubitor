export interface XmlElement {
  name: string;
  children: XmlElement[];
  value: string;
}

const NAME = '[A-Za-z_][\\w.:-]*';
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&apos;': "'", '&quot;': '"' };
const MAX_DEPTH = 32;

function decodeText(text: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) throw new Error('invalid_aws_xml_character');
  return text.replace(/&(?:#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6})|[A-Za-z]{1,4});|&/g, (entity) => {
    if (Object.hasOwn(ENTITIES, entity)) return ENTITIES[entity]!;
    if (!entity.startsWith('&#')) throw new Error('invalid_aws_xml_entity');
    const hexadecimal = entity.startsWith('&#x');
    const code = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
    if (![9, 10, 13].includes(code) && !(code >= 0x20 && code <= 0x10ffff
      && (code < 0xd800 || code > 0xdfff) && code !== 0xfffe && code !== 0xffff)) {
      throw new Error('invalid_aws_xml_character');
    }
    return String.fromCodePoint(code);
  });
}

/** EC2/STS send a UTF-8 element tree with optional namespace attributes. */
export function parseAwsXml(body: string): XmlElement {
  const tag = new RegExp(`<(${NAME})(?:[ \\t\\r\\n]+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*\\s*(/?)>|</(${NAME})\\s*>`, 'y');
  const declaration = /^\uFEFF?(?:<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>)?/i;
  let offset = body.match(declaration)?.[0].length ?? 0;
  const stack: { name: string; element: XmlElement }[] = [];
  let root: XmlElement | undefined;
  while (offset < body.length) {
    const parent = stack.at(-1)?.element;
    if (body[offset] !== '<') {
      const next = body.indexOf('<', offset);
      const end = next < 0 ? body.length : next;
      const text = body.slice(offset, end);
      if (parent) parent.value += decodeText(text);
      else if (text.trim()) throw new Error('invalid_aws_xml_text');
      offset = end;
      continue;
    }
    tag.lastIndex = offset;
    const match = tag.exec(body);
    if (!match) throw new Error('invalid_aws_xml_markup');
    const [, opening, selfClosing, closing] = match;
    offset = tag.lastIndex;
    if (!opening) {
      if (stack.pop()?.name !== closing) throw new Error('invalid_aws_xml_close');
      continue;
    }
    if (stack.length >= MAX_DEPTH) throw new Error('aws_xml_depth');
    const element = { name: opening.slice(opening.lastIndexOf(':') + 1), children: [], value: '' };
    if (parent) parent.children.push(element);
    else if (root) throw new Error('aws_xml_multiple_roots');
    else root = element;
    if (!selfClosing) stack.push({ name: opening, element });
  }
  if (!root || stack.length) throw new Error('incomplete_aws_xml');
  return root;
}

export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((item) => item.name === name);
}

export function value(element: XmlElement | undefined, name: string): string | undefined {
  return child(element, name)?.value.trim();
}

export function items(element: XmlElement | undefined, name: string): XmlElement[] {
  return child(element, name)?.children.filter((item) => item.name === 'item') ?? [];
}
