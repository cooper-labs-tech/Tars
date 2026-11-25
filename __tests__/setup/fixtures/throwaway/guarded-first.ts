// The order the test files of #596 use: the home's guard first, then anything that loads electron/constants, whose
// load settles ~/.dorothy and ~/.tars in os.homedir() (core/data-dir-move.ts).
import '../../throwaway-home';
import '../../../../electron/constants';
