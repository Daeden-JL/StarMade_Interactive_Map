package api.mod;

public abstract class StarMod {
    public abstract void onEnable();
    public abstract void onDisable();
    
    public void logInfo(String message) {
        System.out.println("[StarMod INFO] " + message);
    }
    
    public void logWarn(String message) {
        System.out.println("[StarMod WARN] " + message);
    }
    
    public void logError(String message, Throwable t) {
        System.err.println("[StarMod ERROR] " + message);
        if (t != null) t.printStackTrace();
    }
}
