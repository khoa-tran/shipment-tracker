// Import carriers to trigger self-registration
// Only enabled carriers are imported; others commented out until verified
import './msc';
import './evergreen'; // emc/evergreen
import './hmm';
import './zim';
import './oocl'; // Last: may require CAPTCHA
// import './maersk';
// import './cmacgm';
// import './hapag';
import './cosco';
// import './one';
// import './yangming';

export { registry } from './registry';
