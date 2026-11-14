#include "gain_analysis.c"
#include "common.h"
int main(void) {
    printf("/** ReplayGain Yule filter coefficients, [rate_index*%d + i] */\n", N(ABYule[0])); pf("ABYule", &ABYule[0][0], 9 * N(ABYule[0]));
    printf("/** ReplayGain Butterworth filter coefficients, [rate_index*%d + i] */\n", N(ABButter[0])); pf("ABButter", &ABButter[0][0], 9 * N(ABButter[0]));
    return 0;
}
