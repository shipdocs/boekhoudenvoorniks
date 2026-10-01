/**
 * Een echte, kleine JPEG (48 × 72, een "bonnetje" met een paar streepjes) voor tests van de
 * bonnenscanner. Met een eigen label wordt het een andere foto (ander bestand, andere hash): het label
 * gaat als commentaar in het bestand, de afbeelding blijft geldig.
 */
const BASE = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCABIADADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAIEBv/EACMQAAAEBgMAAwAAAAAAAAAAAAACAwQBBRNUlNM1dLJBUqH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A6h05XTdIt2yKap1CHPGKisSQhAsSw+Cx+34JqzO0aZRtYK8016y3pIKsztGmUbWAVZnaNMo2sKsztGmUbWFWZ2jTKNrCrM7RplG1gFWZ2jTKNrFNXK6jpZu5RTSOmQh4RTVieEYGiaHyWH1/RNWZ2jTKNrBLmnXWR9KgCvNNest6SCrM7RplG1grzTXrLekgqzO0aZRtYBVmdo0yjawqzO0aZRtYVZnaNMo2sKsztGmUbWAVZnaNMo2sEuaddZH0qFWZ2jTKNrBLmnXWR9KgCvNNest6SCrM7RplG1grzTXrLekgqzO0aZRtYBVmdo0yjawqzO0aZRtYVZnaNMo2sKsztGmUbWAVZnaNMo2sEuaddZH0qFWZ2jTKNrBLmnXWR9KgCvNNest6SCrM7RplG1grzTXrLekhtAYqsztGmUbWFWZ2jTKNrG0AGKrM7RplG1glzTrrI+lRtGJLmnXWR9KgKdNl1HSLhssmkdMhyRgolE8IwNEsfg0Pr+iaUzu2mKbYAAFKZ3bTFNsClM7tpim2AABSmd20xTbBTVsum6WcOVk1TqEISEE0okhCBYmj8mj9vwAAf//Z',
  'base64',
);

export function makeJpeg(label = ''): Buffer {
  if (!label) return Buffer.from(BASE);
  const text = Buffer.from(label, 'utf8');
  const com = Buffer.alloc(4);
  com.writeUInt16BE(0xfffe, 0);
  com.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([BASE.subarray(0, 2), com, text, BASE.subarray(2)]);
}
