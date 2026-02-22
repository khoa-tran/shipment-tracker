// Import carriers to trigger self-registration
// Only enabled carriers are imported; others commented out until verified
import './msc';
import './evergreen'; // emc/evergreen
import './hmm';
import './zim';
import './sealead';
import './oocl'; // Last: may require CAPTCHA
import './maersk';
import './cmacgm';
import './cosco';
import './one';
import './yangming';
import './kmtc';

export { registry } from './registry';
