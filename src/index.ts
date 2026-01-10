import { GoogleDriveAdapter } from './adapter';

export default function (PouchDB: any) {
    PouchDB.adapter('googledrive', GoogleDriveAdapter(PouchDB), true);
}
