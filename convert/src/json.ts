// Functions to auto-detect types and convert a batch of files into an array of Modus JSON's, 
// with suggested output filenames.  Just give each input file a filename whose extension 
// reflects its type, and 
import debug from 'debug';
import ModusResult, { assert as assertModusResult } from '@oada/types/modus/v1/modus-result.js';
import { parse as csvParse, supportedFormats } from './csv.js';
import { parseModusResult as xmlParseModusResult } from './xml.js';
import { parse as zipParse } from './zip.js';

const error = debug('@modusjs/convert#tojson:error');
const warn = debug('@modusjs/convert#tojson:error');
const info = debug('@modusjs/convert#tojson:info');
const trace = debug('@modusjs/convert#tojson:trace');

export type SupportedFileType = 'xml' | 'csv' | 'xlsx' | 'json' | 'zip';
export const supportedFileTypes = [ 'xml', 'csv', 'xlsx', 'json', 'zip' ];

export { ModusResult };

export type ModusJSONConversionResult = {
  original_filename: string,
  original_type: SupportedFileType,
  output_filename: string,
  modus: ModusResult
};

export type InputFile = {
  filename: string, // can include the path on the front
  format?: 'tomkat' | 'generic', // only for CSV/XLSX files, default tomkat (same as generic for now)
  str?: string,
  // zip or xlsx can either be ArrayBuffer or base64 string of original file.
  // Do not use for other types, they should all just be strings.
  arrbuf?: ArrayBuffer,
  base64?: string,
};

// This function will attempt to convert all the input files into an array of Modus JSON files
export async function toJson(files: InputFile[] | InputFile): Promise<ModusJSONConversionResult[]> {
  if (!Array.isArray(files)) {
    files = [ files ];
  }
  let results: ModusJSONConversionResult[] = [];
  for (const file of files) {
    const format = file.format || 'tomkat';
    let original_type = typeFromFilename(file.filename);
    if (!original_type) {
      warn('WARNING: unable to determine file type from filename',file.filename,'.  Supported types are:',supportedFileTypes,'.  Skipping file.');
      continue;
    }

    if (original_type === 'csv' || original_type === 'xlsx') {
      if (!supportedFormats.find(f => f === format)) {
        warn('ERROR: format', format, 'is not supported for file', file.filename,'.  Supported formats are: ', supportedFormats,'.  Skipping file.');
        continue;
      }
    }
    switch(original_type) {
      case 'xlsx': 
      case 'zip':
        if (!file.arrbuf && !file.base64) {
          warn('Type of',file.filename,'was',original_type, 'but that must be an ArrayBuffer or Base64 encoded string.  Skipping.');
          continue;
        }
      break;
      case 'csv':
      case 'xml':
      case 'json':
        if (!file.str) {
          warn('CSV, XML, and JSON input files must be strings, but file', file.filename, 'is not.');
          continue;
        }
    }
    const base = { original_filename: file.filename, original_type };
    const type = original_type; // just to make things shorter later in json filename determination
    const filename = file.filename;
    let output_filename = '';
    let modus: ModusResult | any | null = null;
    try {
      switch(original_type) {
        case 'zip':
          const zip_modus = await zipParse(file);
          results = [ ...results, ...zip_modus ];
        break;
        case 'json': 
          modus = JSON.parse(file.str!);
          assertModusResult(modus); // catch below will inform if parsing or assertion failed.
          output_filename = jsonFilenameFromOriginalFilename({ modus, type, filename });
          results.push({ modus, output_filename, ...base }); // just one Modus in this case
        break;
        case 'xml':
          modus = xmlParseModusResult(file.str!);
          output_filename = jsonFilenameFromOriginalFilename({ modus, type, filename });
          if (modus) {
            results.push({ modus, output_filename, ...base }); // just one 
          }
        break;
        case 'csv':
        case 'xlsx':
          let parseargs;
          if (original_type === 'csv') parseargs = { str: file.str, format };
          else {
            if (file.arrbuf) parseargs = { arrbuf: file.arrbuf, format }; // checked for at least one of these above
            else             parseargs = { base64: file.base64, format };
          }
          const all_modus = csvParse(parseargs);
          for (const [index, modus] of all_modus.entries()) {
            const filename_args: FilenameArgs = { modus, type, filename };
            if (all_modus.length > 1) { // multiple things, then use the index
              filename_args.index = index;
            }
            output_filename = jsonFilenameFromOriginalFilename(filename_args);
            results.push({ modus, output_filename, ...base });
          }
        break;
      }
    } catch (e: any) {
      if (e.errors  && e.input && Array.isArray(e.errors)) { // AJV error
        warn('ERROR: failed to validate file', file.filename);
        for (const ajv_error of e.errors) {
          warn('Path', ajv_error.instancePath, ajv_error.message); // '/path/to/item' 'must be an array'
        }
      } else {
        warn('ERROR: failed to read file', file.filename);
        console.log(e);
      }
      continue; // if error, move on to the next file
    }
  } // end for loop on filenames
  return results;
}

// If index is defined, it will name the file with the index
// If type is csv or xlsx, it will try to grab the FileDescription from the report to include the sheetname as part of the filename
type FilenameArgs = {
  modus: ModusResult, 
  index?: number, 
  filename: string, 
  type: SupportedFileType
};
function jsonFilenameFromOriginalFilename({ modus, index, filename, type }: FilenameArgs): string {
  const output_filename_base = filename.replace(/\.(xml|csv|xlsx|zip)$/,'.json');
  let output_filename = output_filename_base;
  // xslx and csv store the sheetname + group number in FileDescription, we can name things by that
  const filedescription = modus?.Events?.[0]?.LabMetaData?.Reports?.[0]?.FileDescription;
  if ((type === 'xlsx' || type === 'csv' || type === 'zip') && filedescription) {
    output_filename = output_filename.replace(/\.json$/, `${filedescription.replace(/[^a-zA-Z0-9_\\-]*/g,'')}.json`);
  } else {
    if (typeof index !== 'undefined') { // more than one result, have to number the output files
      output_filename = output_filename.replace(/\.json$/, `_${index}.json`);
    }
  }
  return output_filename;
}

export function typeFromFilename(filename: string): SupportedFileType | null {
  if (filename.match(/\.xml$/)) return 'xml';
  if (filename.match(/\.csv$/)) return 'csv';
  if (filename.match(/\.xlsx$/)) return 'xlsx';
  if (filename.match(/.json$/)) return 'json';
  if (filename.match(/.zip/)) return 'zip';
  return null;
}
