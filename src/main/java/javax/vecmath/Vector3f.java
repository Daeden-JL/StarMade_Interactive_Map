package javax.vecmath;

public class Vector3f {
    public float x, y, z;
    
    public Vector3f() {}
    
    public Vector3f(float x, float y, float z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }
    
    public void set(Vector3f other) {
        this.x = other.x;
        this.y = other.y;
        this.z = other.z;
    }
}
