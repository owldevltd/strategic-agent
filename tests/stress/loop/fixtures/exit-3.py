# A sandbox script that fails and talks a lot on stderr, quoting data on the way.
import sys
sys.stderr.write("row of Anna Example, workload 1; " * 200)
sys.exit(3)
