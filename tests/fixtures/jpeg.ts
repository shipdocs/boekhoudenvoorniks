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

/**
 * Dezelfde foto zoals een telefoon hem maakt met locatie aan: EXIF met merk, draairichting (6: gekanteld),
 * datum en een GPS-map (52°5'26.52"N 5°7'17.04"E, hoogte, datum), en een XMP-blok met dezelfde positie.
 */
const WITH_GPS = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4QEFRXhpZgAASUkqAAgAAAAEAA8BAgANAAAAPgAAABIBAwABAAAABgAAADIBAgAUAAAATAAAACWIBAABAAAAYAAAAAAAAABUZXN0dGVsZWZvb24AADIwMjY6MTA6MDEgMTA6MDA6MDAABwAAAAEABAAAAAIDAAABAAIAAgAAAE4AAAACAAUAAwAAALoAAAADAAIAAgAAAEUAAAAEAAUAAwAAANIAAAAGAAUAAQAAAOoAAAAdAAIACwAAAPIAAAAAAAAANAAAAAEAAAAFAAAAAQAAAFwKAABkAAAABQAAAAEAAAAHAAAAAQAAAKgGAABkAAAAfQAAAAoAAAAyMDI2OjEwOjAxAP/hARFodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvADx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iPjxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+PHJkZjpEZXNjcmlwdGlvbiB4bWxuczpleGlmPSJodHRwOi8vbnMuYWRvYmUuY29tL2V4aWYvMS4wLyIgZXhpZjpHUFNMYXRpdHVkZT0iNTIsNS40NDJOIiBleGlmOkdQU0xvbmdpdHVkZT0iNSw3LjI4NEUiLz48L3JkZjpSREY+PC94OnhtcG1ldGE+/9sAQwAUDg8SDw0UEhASFxUUGB4yIR4cHB49LC4kMklATEtHQEZFUFpzYlBVbVZFRmSIZW13e4GCgU5gjZeMfZZzfoF8/9sAQwEVFxceGh47ISE7fFNGU3x8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8/8AAEQgASAAwAwEiAAIRAQMRAf/EABcAAQEBAQAAAAAAAAAAAAAAAAACBAb/xAAjEAAABAYDAAMAAAAAAAAAAAAAAgMEAQUTVJTTNXSyQVKh/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AOodOV03SLdsimqdQhzxiorEkIQLEsPgsft+CasztGmUbWCvNNest6SCrM7RplG1gFWZ2jTKNrCrM7RplG1hVmdo0yjawqzO0aZRtYBVmdo0yjaxTVyuo6WbuUU0jpkIeEU1YnhGBomh8lh9f0TVmdo0yjawS5p11kfSoArzTXrLekgqzO0aZRtYK8016y3pIKsztGmUbWAVZnaNMo2sKsztGmUbWFWZ2jTKNrCrM7RplG1gFWZ2jTKNrBLmnXWR9KhVmdo0yjawS5p11kfSoArzTXrLekgqzO0aZRtYK8016y3pIKsztGmUbWAVZnaNMo2sKsztGmUbWFWZ2jTKNrCrM7RplG1gFWZ2jTKNrBLmnXWR9KhVmdo0yjawS5p11kfSoArzTXrLekgqzO0aZRtYK8016y3pIbQGKrM7RplG1hVmdo0yjaxtABiqzO0aZRtYJc066yPpUbRiS5p11kfSoCnTZdR0i4bLJpHTIckYKJRPCMDRLH4ND6/omlM7tpim2AABSmd20xTbApTO7aYptgAAUpndtMU2wU1bLpulnDlZNU6hCEhBNKJIQgWJo/Jo/b8AAH//2Q==',
  'base64',
);
export const GPS_POSITION = { lat: 52 + 5 / 60 + 26.52 / 3600, lon: 5 + 7 / 60 + 17.04 / 3600 };

export function makeJpegWithGps(label = ''): Buffer {
  if (!label) return Buffer.from(WITH_GPS);
  const text = Buffer.from(label, 'utf8');
  const com = Buffer.alloc(4);
  com.writeUInt16BE(0xfffe, 0);
  com.writeUInt16BE(text.length + 2, 2);
  // het commentaar vlak vóór de beelddata, na alle gegevens over de foto
  const at = WITH_GPS.indexOf(Buffer.from([0xff, 0xdb]));
  return Buffer.concat([WITH_GPS.subarray(0, at), com, text, WITH_GPS.subarray(at)]);
}
