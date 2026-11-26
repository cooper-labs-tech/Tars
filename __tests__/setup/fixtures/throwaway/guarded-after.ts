// The order those files had until 25/11: electron/constants loaded first, the guard called after it.
import { DATA_DIR, PRIVATE_DIR } from '../../../../electron/constants';
import { assertThrowaway } from '../../throwaway-dirs';

assertThrowaway({ DATA_DIR, PRIVATE_DIR });
